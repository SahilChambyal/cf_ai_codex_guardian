/**
 * Eval runner.
 *
 *   npm run eval                                   # offline: deterministic rules only
 *   npm run eval -- --url https://x.workers.dev    # full hybrid engine via /api/scan
 *   npm run eval -- --url ... --token $SCAN_API_TOKEN
 *   npm run eval -- --strict                       # exit 1 if any case fails (CI)
 *
 * Offline mode scores only deterministic rules (no model, no network), so it
 * runs in CI on every commit. Remote mode scores everything, including the
 * AI-judged rules and the prompt-injection cases.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnifiedDiff, synthesizeDiff } from "../src/codex/diff";
import { scanFiles } from "../src/codex/engine";
import { DETERMINISTIC_RULES, RULES } from "../src/codex/rules";
import type { Finding } from "../src/codex/types";
import { CASES, type EvalCase } from "./cases";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const baseUrl = arg("url")?.replace(/\/$/, "");
const token = arg("token") ?? process.env.SCAN_API_TOKEN;
const only = arg("case");
const mode = baseUrl ? "remote" : "offline";
const DETERMINISTIC = new Set(DETERMINISTIC_RULES.map((r) => r.id));

interface CaseResult {
  id: string;
  tags: string[];
  expected: string[];
  found: string[];
  missing: string[];
  unexpected: string[];
  pass: boolean;
  latencyMs: number;
  notes: string[];
  error?: string;
}

async function scanRemote(
  diff: string
): Promise<{ findings: Finding[]; notes: string[] }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`${baseUrl}/api/scan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ diff })
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 12_000));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as { findings: Finding[]; notes: string[] };
  }
  throw new Error("rate limited too many times");
}

async function runCase(c: EvalCase): Promise<CaseResult> {
  const diff = synthesizeDiff(c.files);
  const ignore = new Set(c.ignore ?? []);
  const inScope = (id: string) =>
    !ignore.has(id) && (mode === "remote" || DETERMINISTIC.has(id));
  const started = Date.now();
  let findings: Finding[] = [];
  let notes: string[] = [];
  let error: string | undefined;
  try {
    const res =
      mode === "remote"
        ? await scanRemote(diff)
        : await scanFiles(parseUnifiedDiff(diff), { now: new Date() });
    findings = res.findings;
    notes = res.notes.filter(
      (n) => !n.startsWith("AI-judged rules were not run")
    );
  } catch (err) {
    error = String(err);
  }
  const expected = [...new Set(c.expect.filter(inScope))].sort();
  const found = [
    ...new Set(findings.map((f) => f.ruleId).filter(inScope))
  ].sort();
  const missing = expected.filter((r) => !found.includes(r));
  const unexpected = found.filter((r) => !expected.includes(r));
  return {
    id: c.id,
    tags: c.tags ?? [],
    expected,
    found,
    missing,
    unexpected,
    pass: !error && missing.length === 0 && unexpected.length === 0,
    latencyMs: Date.now() - started,
    notes,
    error
  };
}

async function main() {
  const cases = CASES.filter((c) => !only || c.id === only);
  const results: CaseResult[] = [];
  // Remote: small concurrency to stay polite to Workers AI and the rate limiter.
  const concurrency = mode === "remote" ? 2 : 8;
  const queue = [...cases];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const r = await runCase(c);
        results.push(r);
        const mark = r.pass ? "✓" : "✗";
        const detail = r.error
          ? ` error: ${r.error}`
          : `${r.missing.length ? ` missing ${r.missing.join(",")}` : ""}${r.unexpected.length ? ` unexpected ${r.unexpected.join(",")}` : ""}`;
        console.log(
          `${mark} ${r.id.padEnd(28)} ${String(r.latencyMs).padStart(6)}ms${detail}`
        );
      }
    })
  );
  results.sort(
    (a, b) =>
      cases.findIndex((c) => c.id === a.id) -
      cases.findIndex((c) => c.id === b.id)
  );

  // Per-rule confusion counts over (case, rule) pairs.
  const scoredRules = RULES.filter(
    (r) => mode === "remote" || DETERMINISTIC.has(r.id)
  );
  const perRule = scoredRules.map((rule) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const r of results) {
      const exp = r.expected.includes(rule.id);
      const got = r.found.includes(rule.id);
      if (exp && got) tp++;
      else if (got) fp++;
      else if (exp) fn++;
    }
    return { rule: rule.id, kind: rule.kind, tp, fp, fn };
  });
  const sum = perRule.reduce(
    (a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn }),
    { tp: 0, fp: 0, fn: 0 }
  );
  const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
  const pct = (x: number | null) =>
    x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
  const precision = ratio(sum.tp, sum.tp + sum.fp);
  const recall = ratio(sum.tp, sum.tp + sum.fn);

  const injection = results.filter((r) => r.tags.includes("injection"));
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pctile = (p: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];

  const summary = {
    mode,
    target: baseUrl ?? "local engine (deterministic rules only)",
    ranAt: new Date().toISOString(),
    cases: results.length,
    casesPassed: results.filter((r) => r.pass).length,
    precision,
    recall,
    injectionCasesPassed: `${injection.filter((r) => r.pass).length}/${injection.length}`,
    latencyMs: { p50: pctile(0.5), p95: pctile(0.95) },
    errors: results.filter((r) => r.error).length
  };

  const md = [
    `# Eval results — ${mode}`,
    "",
    `- Target: ${summary.target}`,
    `- Ran at: ${summary.ranAt}`,
    `- Cases passed: **${summary.casesPassed}/${summary.cases}**`,
    `- Precision: **${pct(precision)}** · Recall: **${pct(recall)}** (micro-averaged over case × rule)`,
    mode === "remote"
      ? `- Prompt-injection cases passed: **${summary.injectionCasesPassed}**`
      : "- Prompt-injection and AI-judged rules: not scored offline (run with `--url`)",
    mode === "remote"
      ? `- Latency per scan: p50 ${summary.latencyMs.p50}ms · p95 ${summary.latencyMs.p95}ms`
      : "",
    "",
    "| Rule | Kind | TP | FP | FN | Precision | Recall |",
    "|---|---|---|---|---|---|---|",
    ...perRule.map(
      (r) =>
        `| ${r.rule} | ${r.kind} | ${r.tp} | ${r.fp} | ${r.fn} | ${pct(ratio(r.tp, r.tp + r.fp))} | ${pct(ratio(r.tp, r.tp + r.fn))} |`
    ),
    "",
    "| Case | Result | Expected | Found |",
    "|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.error ? "error" : r.pass ? "pass" : "fail"} | ${r.expected.join(", ") || "—"} | ${r.found.join(", ") || "—"} |`
    ),
    ""
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "");

  const outDir = join(dirname(fileURLToPath(import.meta.url)), "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${mode}.json`),
    JSON.stringify({ summary, perRule, results }, null, 2)
  );
  writeFileSync(join(outDir, `${mode}.md`), md.join("\n"));

  console.log(
    `\n${summary.casesPassed}/${summary.cases} cases passed · precision ${pct(precision)} · recall ${pct(recall)}` +
      (mode === "remote"
        ? ` · injection ${summary.injectionCasesPassed} · p50 ${summary.latencyMs.p50}ms`
        : "")
  );
  console.log(`Report written to evals/results/${mode}.md`);
  if (summary.errors > 0) process.exitCode = 1;
  // --strict: any failing case fails the run (used as the CI regression gate).
  if (args.includes("--strict") && summary.casesPassed < summary.cases)
    process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
