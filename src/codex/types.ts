export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

export type FileStatus = "added" | "modified" | "removed" | "renamed";

export interface AddedLine {
  /** 1-indexed line number in the new version of the file. */
  line: number;
  text: string;
}

export interface DiffFile {
  path: string;
  status: FileStatus;
  addedLines: AddedLine[];
  /** Count of removed lines; the content itself is never evaluated. */
  removedCount: number;
  /**
   * True when the scanner saw only part of this file's changes (GitHub omits
   * patches for large/binary files, and we cap lines per file).
   */
  truncated: boolean;
}

export type FindingSource = "deterministic" | "llm";

export interface Finding {
  /** Stable within a scan: ruleId + file + line. Used to diff scans. */
  fingerprint: string;
  ruleId: string;
  severity: Severity;
  file: string;
  line?: number;
  message: string;
  source: FindingSource;
  /** The offending line, redacted where it may contain secrets. */
  evidence?: string;
}

export interface ScanStats {
  filesScanned: number;
  filesTruncated: number;
  addedLines: number;
  llmBatches: number;
  llmBatchesFailed: number;
  durationMs: number;
}

export interface ScanResult {
  findings: Finding[];
  stats: ScanStats;
  /** Human-readable notes about partial coverage (skipped files, failed batches). */
  notes: string[];
}
