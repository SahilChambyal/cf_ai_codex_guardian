/**
 * The Engineering Codex, expressed as policy-as-code.
 *
 * Design rule: anything a regex or a file-presence check can decide is a
 * deterministic rule. The LLM only gets rules that need judgment (is this
 * input untrusted? is this route public on purpose?). Deterministic rules
 * cannot hallucinate and cannot be prompt-injected, and false positives are
 * what make developers ignore a guardrail.
 */
import {
  dirname,
  isCodeFile,
  isDocFile,
  isDockerfile,
  isGeneratedOrVendored,
  isTestFile,
  isWorkflowFile,
  isWranglerConfig
} from "./paths";
import type { AddedLine, DiffFile, Severity } from "./types";

export interface RuleContext {
  /** Injected so date-based rules are deterministic in tests and evals. */
  now: Date;
}

export interface RuleMatch {
  file: string;
  line?: number;
  message: string;
  evidence?: string;
}

interface RuleBase {
  id: string;
  title: string;
  severity: Severity;
  rationale: string;
  remediation: string;
  /**
   * Critical rules cannot be waived through the self-service exception flow;
   * the only path is to fix the code.
   */
  exceptable: boolean;
}

export interface DeterministicRule extends RuleBase {
  kind: "deterministic";
  evaluate(files: DiffFile[], ctx: RuleContext): RuleMatch[];
}

export interface LlmRule extends RuleBase {
  kind: "llm";
  appliesTo(path: string): boolean;
  /** Precise instructions given to the model, including what NOT to flag. */
  guidance: string;
}

export type Rule = DeterministicRule | LlmRule;

// ── helpers ─────────────────────────────────────────────────────────────

function eachLine(
  files: DiffFile[],
  fileFilter: (path: string) => boolean,
  fn: (file: DiffFile, line: AddedLine) => RuleMatch | undefined
): RuleMatch[] {
  const out: RuleMatch[] = [];
  for (const file of files) {
    if (file.status === "removed" || !fileFilter(file.path)) continue;
    for (const line of file.addedLines) {
      const match = fn(file, line);
      if (match) out.push(match);
    }
  }
  return out;
}

const clip = (s: string, n = 160) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// ── CX-SEC-001: hard-coded secrets ──────────────────────────────────────

const SECRET_PATTERNS: Array<{ name: string; re: RegExp; generic?: true }> = [
  { name: "AWS access key ID", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{20,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  {
    name: "Credential assignment",
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i,
    generic: true
  }
];

const PLACEHOLDER =
  /^(\$\{|\{\{|<|%|your|example|changeme|placeholder|dummy|redacted|replace|todo|xxx|\*{3})/i;

export function redact(text: string, secret: string): string {
  const keep = secret.slice(0, 4);
  return clip(text.split(secret).join(`${keep}…[redacted]`));
}

const secretRule: DeterministicRule = {
  kind: "deterministic",
  id: "CX-SEC-001",
  title: "Hard-coded secret",
  severity: "critical",
  exceptable: false,
  rationale:
    "Secrets committed to source control are exposed to everyone with read access and persist in git history even after deletion.",
  remediation:
    "Remove the value, rotate the credential immediately, and load it from a secret store (e.g. `wrangler secret put`, Vault) at runtime.",
  evaluate: (files) =>
    eachLine(
      files,
      (p) => !isGeneratedOrVendored(p),
      (file, { line, text }) => {
        for (const { name, re, generic } of SECRET_PATTERNS) {
          const m = re.exec(text);
          if (!m) continue;
          const secret = generic ? m[1] : m[0];
          if (/EXAMPLE/i.test(secret)) continue; // AWS docs' canonical fake key
          if (generic) {
            // Generic assignments are noisy: require high entropy and skip
            // tests/docs where fake credentials are expected.
            if (isTestFile(file.path) || isDocFile(file.path)) continue;
            if (PLACEHOLDER.test(secret)) continue;
            if (shannonEntropy(secret) < 3.0) continue;
          }
          return {
            file: file.path,
            line,
            message: `${name} committed in source.`,
            evidence: redact(text, secret)
          };
        }
        return undefined;
      }
    )
};

// ── CX-CI-001: unpinned third-party actions ─────────────────────────────

const USES = /^\s*-?\s*uses:\s*["']?([^"'\s#]+)["']?/;

const pinnedActionsRule: DeterministicRule = {
  kind: "deterministic",
  id: "CX-CI-001",
  title: "GitHub Action not pinned to a commit SHA",
  severity: "high",
  exceptable: true,
  rationale:
    "Tags and branches are mutable. A compromised upstream action (e.g. tj-actions/changed-files, 2025) executes with the workflow's token and secrets.",
  remediation:
    "Pin to the full 40-character commit SHA and keep the version as a comment: `uses: actions/checkout@<sha> # v4.2.2`. Let Dependabot/Renovate bump it.",
  evaluate: (files) =>
    eachLine(files, isWorkflowFile, (file, { line, text }) => {
      const m = USES.exec(text);
      if (!m) return undefined;
      const ref = m[1];
      if (ref.startsWith("./") || ref.startsWith("docker://")) return undefined;
      const at = ref.lastIndexOf("@");
      const version = at === -1 ? "" : ref.slice(at + 1);
      if (/^[0-9a-f]{40}$/.test(version)) return undefined;
      return {
        file: file.path,
        line,
        message: version
          ? `\`${ref.slice(0, at)}\` is pinned to mutable ref \`${version}\`.`
          : `\`${ref}\` has no version pin at all.`,
        evidence: clip(text)
      };
    })
};

// ── CX-CI-002: over-privileged workflows ────────────────────────────────

const workflowPermissionsRule: DeterministicRule = {
  kind: "deterministic",
  id: "CX-CI-002",
  title: "Over-privileged CI workflow",
  severity: "high",
  exceptable: true,
  rationale:
    '`write-all` hands every step a token that can push code and cut releases. `pull_request_target` plus checking out the PR head runs untrusted fork code with secrets ("pwn request").',
  remediation:
    "Declare least-privilege `permissions:` per job (start from `contents: read`). Never check out `github.event.pull_request.head` in a `pull_request_target` workflow.",
  evaluate: (files) => {
    const out: RuleMatch[] = [];
    for (const file of files) {
      if (file.status === "removed" || !isWorkflowFile(file.path)) continue;
      const prTarget = file.addedLines.find((l) =>
        /\bpull_request_target\b/.test(l.text)
      );
      const headCheckout = file.addedLines.find((l) =>
        /github\.event\.pull_request\.head\.(sha|ref)/.test(l.text)
      );
      for (const { line, text } of file.addedLines) {
        if (/^\s*permissions:\s*write-all\b/.test(text)) {
          out.push({
            file: file.path,
            line,
            message: "Workflow grants `write-all` permissions to its token.",
            evidence: clip(text)
          });
        }
      }
      if (prTarget && headCheckout) {
        out.push({
          file: file.path,
          line: headCheckout.line,
          message:
            "`pull_request_target` workflow checks out untrusted PR head code while holding secrets.",
          evidence: clip(headCheckout.text)
        });
      }
    }
    return out;
  }
};

// ── CX-CTR-001: containers running as root ──────────────────────────────

const containerRootRule: DeterministicRule = {
  kind: "deterministic",
  id: "CX-CTR-001",
  title: "Container image runs as root",
  severity: "medium",
  exceptable: true,
  rationale:
    "A root process turns any container escape or RCE into host-level compromise and violates the restricted Pod Security Standard.",
  remediation:
    "Add a non-root user in the final stage (`RUN adduser -D -u 10001 app` / `USER 10001`) or use a distroless `:nonroot` base image.",
  evaluate: (files) => {
    const out: RuleMatch[] = [];
    for (const file of files) {
      if (file.status === "removed" || !isDockerfile(file.path)) continue;
      const lines = file.addedLines;
      let lastFrom = -1;
      lines.forEach((l, i) => {
        if (/^\s*FROM\s/i.test(l.text)) lastFrom = i;
      });
      // Only the final stage's USER matters in a multi-stage build.
      const finalStage = lastFrom === -1 ? lines : lines.slice(lastFrom);
      const lastUser = finalStage
        .filter((l) => /^\s*USER\s/i.test(l.text))
        .pop();

      if (lastUser && /^\s*USER\s+(root|0)(:\S+)?\s*$/i.test(lastUser.text)) {
        out.push({
          file: file.path,
          line: lastUser.line,
          message: "Final stage explicitly switches to the root user.",
          evidence: clip(lastUser.text)
        });
      } else if (
        !lastUser &&
        file.status === "added" &&
        lastFrom !== -1 &&
        !/:nonroot\b|distroless.*nonroot/i.test(lines[lastFrom].text)
      ) {
        out.push({
          file: file.path,
          line: lines[lastFrom].line,
          message:
            "New Dockerfile never sets `USER`; the container will run as root.",
          evidence: clip(lines[lastFrom].text)
        });
      }
    }
    return out;
  }
};

// ── CX-DEP-001: manifest changed without lockfile ───────────────────────

const NON_DEP_KEYS = new Set([
  "name",
  "version",
  "description",
  "main",
  "module",
  "types",
  "typings",
  "license",
  "author",
  "homepage",
  "type",
  "packageManager",
  "private",
  "node",
  "npm",
  "engines",
  "exports",
  "bin"
]);
const JS_LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

const lockfileRule: DeterministicRule = {
  kind: "deterministic",
  id: "CX-DEP-001",
  title: "Dependency change without lockfile update",
  severity: "medium",
  exceptable: true,
  rationale:
    "Without a lockfile change, CI and production resolve versions at install time: builds stop being reproducible and a malicious new release can slip in unreviewed.",
  remediation:
    "Run the package manager install (`npm install`, `go mod tidy`) and commit the updated lockfile in the same PR.",
  evaluate: (files) => {
    const out: RuleMatch[] = [];
    const paths = new Set(files.map((f) => f.path));
    const anyJsLock = files.some((f) => JS_LOCKFILE.test(f.path));

    for (const file of files) {
      if (file.status === "removed") continue;
      if (/(^|\/)package\.json$/.test(file.path) && !anyJsLock) {
        const dep = file.addedLines.find((l) => {
          const m =
            /^\s*"(@?[\w.-]+(?:\/[\w.-]+)?)"\s*:\s*"(?:[\^~<>=*]|\d|workspace:|npm:|git|https?:|file:|link:|latest)/.exec(
              l.text
            );
          return m !== null && !NON_DEP_KEYS.has(m[1]);
        });
        if (dep) {
          out.push({
            file: file.path,
            line: dep.line,
            message:
              "package.json dependencies changed but no lockfile is part of this change.",
            evidence: clip(dep.text)
          });
        }
      }
      if (/(^|\/)go\.mod$/.test(file.path)) {
        const sum = [dirname(file.path), "go.sum"].filter(Boolean).join("/");
        if (paths.has(sum)) continue;
        const dep = file.addedLines.find((l) =>
          /^\s*(require\s+)?[\w.-]+\.[\w.-]+\/\S+\s+v\d/.test(l.text)
        );
        if (dep) {
          out.push({
            file: file.path,
            line: dep.line,
            message: "go.mod requirements changed but go.sum was not updated.",
            evidence: clip(dep.text)
          });
        }
      }
    }
    return out;
  }
};

// ── CX-CFG-001: stale Workers compatibility date ────────────────────────

const STALE_COMPAT_DAYS = 365;

const compatDateRule: DeterministicRule = {
  kind: "deterministic",
  id: "CX-CFG-001",
  title: "Stale Workers compatibility_date",
  severity: "low",
  exceptable: true,
  rationale:
    "An old compatibility_date pins the Worker to outdated runtime behavior and silently opts it out of security and correctness fixes.",
  remediation:
    "Set compatibility_date to a recent date, review the compatibility-flags changelog, and run the test suite.",
  evaluate: (files, { now }) =>
    eachLine(files, isWranglerConfig, (file, { line, text }) => {
      const m = /compatibility_date"?\s*[:=]\s*"(\d{4}-\d{2}-\d{2})"/.exec(
        text
      );
      if (!m) return undefined;
      const date = new Date(`${m[1]}T00:00:00Z`);
      if (Number.isNaN(date.getTime())) return undefined;
      const ageDays = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
      if (ageDays <= STALE_COMPAT_DAYS) return undefined;
      return {
        file: file.path,
        line,
        message: `compatibility_date ${m[1]} is ${ageDays} days old (limit ${STALE_COMPAT_DAYS}).`,
        evidence: clip(text)
      };
    })
};

// ── CX-TLS-001: TLS verification disabled ───────────────────────────────

const TLS_OFF = [
  /rejectUnauthorized\s*:\s*false/,
  /NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*["']?0/,
  /InsecureSkipVerify\s*:\s*true/,
  /\bverify\s*=\s*False\b/,
  /ssl\._create_unverified_context/,
  /\bcurl\b[^\n]*\s(-k|--insecure)\b/
];

const tlsRule: DeterministicRule = {
  kind: "deterministic",
  id: "CX-TLS-001",
  title: "TLS certificate verification disabled",
  severity: "high",
  exceptable: true,
  rationale:
    'Disabling certificate verification makes the connection trivially interceptable; it tends to be added "temporarily" and then reach production.',
  remediation:
    'Keep verification on. For internal CAs, pass the CA bundle explicitly (`ca:` / `RootCAs` / `verify="/path/ca.pem"`).',
  evaluate: (files) =>
    eachLine(
      files,
      (p) => !isTestFile(p) && !isDocFile(p) && !isGeneratedOrVendored(p),
      (file, { line, text }) =>
        TLS_OFF.some((re) => re.test(text))
          ? {
              file: file.path,
              line,
              message: "TLS certificate verification is disabled.",
              evidence: clip(text)
            }
          : undefined
    )
};

// ── CX-AI-001: prompt injection aimed at AI reviewers ───────────────────

const INJECTION = [
  /\b(ignore|disregard|forget|override)\b[^\n]{0,30}\b(previous|prior|above|all|earlier|system)\b[^\n]{0,20}\b(instructions?|prompts?|rules?|guidelines?)\b/i,
  /\b(ai|llm|automated|bot|code)[ -](reviewer|review|assistant|scanner|agent)s?\b[^\n]{0,80}\b(ignore|approve|skip|do not (report|flag)|don't (report|flag)|must not (report|flag)|report no)\b/i,
  /\breport (no|zero|0) (violations|issues|findings|problems)\b/i,
  /\byou are now (a|an|in)\b/i,
  /<\/?(system|untrusted_diff|instructions)>/i
];

const injectionRule: DeterministicRule = {
  kind: "deterministic",
  id: "CX-AI-001",
  title: "Prompt injection aimed at AI tooling",
  severity: "high",
  exceptable: false,
  rationale:
    "Text that instructs AI reviewers or agents to change behavior is an attack on the review pipeline itself, regardless of whether it succeeds.",
  remediation:
    "Remove the instruction text. If it is a legitimate test fixture for AI tooling, move it under a test/fixtures path.",
  evaluate: (files) =>
    eachLine(
      files,
      (p) => !isTestFile(p),
      (file, { line, text }) =>
        INJECTION.some((re) => re.test(text))
          ? {
              file: file.path,
              line,
              message:
                "Contains instructions addressed to AI reviewers/agents.",
              evidence: clip(text)
            }
          : undefined
    )
};

// ── CX-TST-001: substantial code change without tests ──────────────────

const MIN_UNTESTED_LINES = 40;

const testsRule: DeterministicRule = {
  kind: "deterministic",
  id: "CX-TST-001",
  title: "Substantial code change with no test changes",
  severity: "low",
  exceptable: true,
  rationale:
    "Behavior changes without tests regress silently; the Codex requires tests to ship with the logic they cover.",
  remediation:
    "Add or update tests covering the new behavior, including at least one failure path.",
  evaluate: (files) => {
    if (files.some((f) => isTestFile(f.path))) return [];
    const candidates = files.filter(
      (f) =>
        f.status !== "removed" &&
        isCodeFile(f.path) &&
        !isGeneratedOrVendored(f.path) &&
        !/(^|\/)(migrations?|scripts?)\//.test(f.path) &&
        !/\.config\.[cm]?[jt]s$/.test(f.path)
    );
    const total = candidates.reduce(
      (n, f) => n + f.addedLines.filter((l) => l.text.trim()).length,
      0
    );
    if (total < MIN_UNTESTED_LINES) return [];
    const largest = candidates.reduce((a, b) =>
      b.addedLines.length > a.addedLines.length ? b : a
    );
    return [
      {
        file: largest.path,
        message: `${total} non-blank lines of code added across ${candidates.length} file(s) with no test changes.`
      }
    ];
  }
};

// ── LLM-judged rules ────────────────────────────────────────────────────

const codeOnly = (p: string) =>
  isCodeFile(p) && !isTestFile(p) && !isGeneratedOrVendored(p);

const sqlRule: LlmRule = {
  kind: "llm",
  id: "CX-SQL-001",
  title: "SQL built from untrusted input",
  severity: "critical",
  exceptable: false,
  rationale:
    "String-built SQL with request-derived values is injectable; parameterized queries remove the entire bug class.",
  remediation:
    'Use bound parameters (`db.prepare("... WHERE id = ?").bind(id)`, `$1`, named params) or a query builder. Never interpolate request values into SQL text.',
  appliesTo: codeOnly,
  guidance:
    "Flag ONLY when a SQL statement is built by string concatenation, template-literal interpolation, f-strings, or format calls that include a variable which plausibly comes from a request, user, or external input, AND the string is executed. Do NOT flag: parameterized queries using ?, $1, :name, or .bind(); interpolation of constants, table names from a hard-coded allow-list, or numeric literals; ORM/query-builder calls."
};

const authRule: LlmRule = {
  kind: "llm",
  id: "CX-AUTH-001",
  title: "HTTP route without an authorization check",
  severity: "high",
  exceptable: true,
  rationale:
    "Every route that reads or changes non-public data must verify who is calling; missing checks are the most common source of data exposure.",
  remediation:
    "Put the route behind the service's auth middleware (e.g. Cloudflare Access JWT validation) and check that the caller is allowed to access the specific resource.",
  appliesTo: codeOnly,
  guidance:
    "Flag a NEWLY ADDED HTTP route/handler (e.g. app.get/post/put/delete, router.*, Hono/itty/Express handlers, http.HandleFunc, @app.route) that reads or mutates user, account, or internal data and shows NO authentication or authorization step (no auth middleware in the route definition, no session/JWT/token verification, no permission check) in the added code. Do NOT flag: health/readiness checks, static assets, login/signup/OAuth callback endpoints, routes explicitly documented as public, or routes whose router/app visibly applies auth middleware."
};

const loggingRule: LlmRule = {
  kind: "llm",
  id: "CX-LOG-001",
  title: "Sensitive data written to logs",
  severity: "high",
  exceptable: true,
  rationale:
    "Logs are widely readable and long-retained; secrets or personal data in logs is a breach waiting to be queried.",
  remediation:
    "Log identifiers, not payloads. Drop or redact tokens, credentials, cookies, authorization headers, and personal data before logging.",
  appliesTo: codeOnly,
  guidance:
    "Flag a logging/print statement (console.*, log.*, logger.*, fmt.Print*, print(), etc.) that outputs passwords, API keys, tokens, secrets, session cookies, Authorization headers, entire request/response headers or bodies, or personal data (email addresses, phone numbers, IP addresses, full names). Do NOT flag logs of opaque IDs, counts, durations, status codes, or error messages that do not include such data."
};

const swallowedErrorRule: LlmRule = {
  kind: "llm",
  id: "CX-ERR-001",
  title: "Error swallowed silently",
  severity: "medium",
  exceptable: true,
  rationale:
    "Silently discarded errors turn outages into mysteries: the failure happens, but nothing logs, alerts, or propagates it.",
  remediation:
    "Handle the error: log it with context, return/rethrow it, or record a metric. If ignoring is truly correct, say why in a comment.",
  appliesTo: codeOnly,
  guidance:
    "Flag catch/except/rescue blocks or Go `if err != nil` branches in the added code that discard the error with NO logging, NO rethrow/return of the error, and NO metric — e.g. empty `catch {}` blocks, `except: pass`, `_ = err`, or `catch (e) { return null }` on an operation whose failure matters. Do NOT flag errors that are logged, returned, rethrown, converted into an error response, or where a comment explains why ignoring is intentional."
};

export const RULES: readonly Rule[] = [
  secretRule,
  sqlRule,
  pinnedActionsRule,
  workflowPermissionsRule,
  tlsRule,
  injectionRule,
  authRule,
  loggingRule,
  containerRootRule,
  lockfileRule,
  swallowedErrorRule,
  compatDateRule,
  testsRule
];

export const DETERMINISTIC_RULES = RULES.filter(
  (r): r is DeterministicRule => r.kind === "deterministic"
);
export const LLM_RULES = RULES.filter((r): r is LlmRule => r.kind === "llm");

const BY_ID = new Map(RULES.map((r) => [r.id, r]));
export const getRule = (id: string): Rule | undefined =>
  BY_ID.get(id.trim().toUpperCase());

/** Serializable view for tools, the API, and the UI. */
export function describeRule(rule: Rule) {
  return {
    id: rule.id,
    title: rule.title,
    severity: rule.severity,
    kind: rule.kind,
    exceptable: rule.exceptable,
    rationale: rule.rationale,
    remediation: rule.remediation
  };
}
export type RuleDescription = ReturnType<typeof describeRule>;
