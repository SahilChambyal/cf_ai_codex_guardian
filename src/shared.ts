// Types shared by the Worker and the browser. Keep this file free of
// server-only imports so it stays safe to bundle into the client.
import type { ExceptionRecord, ReviewedFinding } from "./codex/exceptions";
import type { ScanStats, Severity } from "./codex/types";

export type ScanStatus = "queued" | "running" | "complete" | "failed";

export interface ScanTarget {
  kind: "pr" | "diff";
  /** Display label: `owner/repo#123` or the diff's label. */
  label: string;
  /** Key used to scope exceptions and compare scans. */
  repo: string;
  url?: string;
  headSha?: string;
  prTitle?: string;
}

export interface ScanSummary {
  id: string;
  target: ScanTarget;
  status: ScanStatus;
  createdAt: number;
  completedAt: number | null;
  /** Unsuppressed findings by severity. */
  counts: Record<Severity, number>;
  suppressed: number;
  progress: { percent: number; message: string } | null;
  error: string | null;
  notes: string[];
  stats: ScanStats | null;
}

export interface CodexState {
  scans: ScanSummary[];
  latest: { scanId: string; findings: ReviewedFinding[] } | null;
  exceptions: ExceptionRecord[];
}

export type StartScanInput =
  | { kind: "pr"; url: string }
  | { kind: "diff"; diff: string; label?: string };

export type StartScanResult =
  | { ok: true; scanId: string; deduplicated: boolean; label: string }
  | { ok: false; error: string };

export const MAX_DIFF_CHARS = 300_000;

export const emptyCounts = (): Record<Severity, number> => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0
});
