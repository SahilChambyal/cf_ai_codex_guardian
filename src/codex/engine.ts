import { fingerprint } from "./fingerprint";
import {
  planLlmBatches,
  runLlmBatch,
  type LlmBatch,
  type LlmClient
} from "./llm";
import { DETERMINISTIC_RULES, type RuleContext } from "./rules";
import {
  SEVERITY_ORDER,
  type DiffFile,
  type Finding,
  type ScanResult
} from "./types";

export function runDeterministicRules(
  files: DiffFile[],
  ctx: RuleContext
): Finding[] {
  const findings: Finding[] = [];
  for (const rule of DETERMINISTIC_RULES) {
    for (const m of rule.evaluate(files, ctx)) {
      findings.push({
        fingerprint: fingerprint(rule.id, m.file, m.evidence ?? m.line),
        ruleId: rule.id,
        severity: rule.severity,
        file: m.file,
        line: m.line,
        message: m.message,
        source: "deterministic",
        evidence: m.evidence
      });
    }
  }
  return findings;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0)
  );
}

/** Drops duplicate fingerprints; a deterministic hit wins over an LLM one. */
export function mergeFindings(...groups: Finding[][]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const f of groups.flat()) {
    const existing = byKey.get(f.fingerprint);
    if (
      !existing ||
      (existing.source === "llm" && f.source === "deterministic")
    ) {
      byKey.set(f.fingerprint, f);
    }
  }
  return sortFindings([...byKey.values()]);
}

export function coverageNotes(files: DiffFile[]): string[] {
  return files
    .filter((f) => f.truncated)
    .map((f) =>
      f.addedLines.length === 0
        ? `${f.path}: no patch available (binary or too large) — not scanned.`
        : `${f.path}: patch truncated — only part of the file was scanned.`
    );
}

export interface ScanOptions {
  now: Date;
  /** Omit to run deterministic rules only (offline evals, AI outage). */
  llm?: LlmClient;
  /** Parallel model calls; Workers AI rate limits per account, so keep small. */
  llmConcurrency?: number;
}

/**
 * Single-shot scan used by the HTTP API, the MCP server, and evals. The chat
 * agent uses the same building blocks inside a Workflow instead, so each
 * model call gets its own durable, retried step.
 */
export async function scanFiles(
  files: DiffFile[],
  opts: ScanOptions
): Promise<ScanResult> {
  const started = Date.now();
  const deterministic = runDeterministicRules(files, { now: opts.now });
  const notes = coverageNotes(files);

  let llmFindings: Finding[] = [];
  let batches: LlmBatch[] = [];
  let failed = 0;

  if (opts.llm) {
    const plan = planLlmBatches(files);
    batches = plan.batches;
    notes.push(...plan.notes);
    const llm = opts.llm;
    const concurrency = Math.max(1, opts.llmConcurrency ?? 3);
    const queue = [...batches];
    const results: Finding[][] = [];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let b = queue.shift(); b; b = queue.shift()) {
          try {
            results.push(await runLlmBatch(b, llm));
          } catch (err) {
            failed++;
            console.error(`LLM batch ${b.index} failed`, err);
          }
        }
      })
    );
    llmFindings = results.flat();
    if (failed > 0) {
      notes.push(
        `${failed} of ${batches.length} AI review batch(es) failed; AI-judged rules have partial coverage.`
      );
    }
  } else {
    notes.push("AI-judged rules were not run (deterministic rules only).");
  }

  return {
    findings: mergeFindings(deterministic, llmFindings),
    stats: {
      filesScanned: files.length,
      filesTruncated: files.filter((f) => f.truncated).length,
      addedLines: files.reduce((n, f) => n + f.addedLines.length, 0),
      llmBatches: batches.length,
      llmBatchesFailed: failed,
      durationMs: Date.now() - started
    },
    notes
  };
}
