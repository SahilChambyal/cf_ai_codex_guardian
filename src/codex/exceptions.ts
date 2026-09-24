import { getRule, type Rule } from "./rules";
import type { Finding } from "./types";

export const MAX_EXCEPTION_DAYS = 90;
export const MIN_REASON_LENGTH = 20;

export interface ExceptionRecord {
  id: string;
  /** Lower-cased `owner/repo`, or a label for pasted diffs. */
  repo: string;
  ruleId: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

export interface ReviewedFinding extends Finding {
  /** Exception id when an active exception waives this finding. */
  suppressedBy?: string;
}

export const normalizeRepo = (repo: string) => repo.trim().toLowerCase();

export function isActive(e: ExceptionRecord, now: number): boolean {
  return e.revokedAt === null && e.expiresAt > now;
}

/**
 * Exceptions are applied at read time rather than baked into stored scans,
 * so granting or revoking one immediately changes every view of past scans
 * without re-running the model.
 */
export function applyExceptions(
  findings: Finding[],
  exceptions: ExceptionRecord[],
  repo: string,
  now: number
): ReviewedFinding[] {
  const key = normalizeRepo(repo);
  const active = new Map<string, string>();
  for (const e of exceptions) {
    if (e.repo === key && isActive(e, now)) active.set(e.ruleId, e.id);
  }
  return findings.map((f) => {
    const suppressedBy = active.get(f.ruleId);
    return suppressedBy ? { ...f, suppressedBy } : f;
  });
}

export type ExceptionValidation =
  | { ok: true; rule: Rule; days: number }
  | { ok: false; error: string };

export function validateExceptionRequest(input: {
  ruleId: string;
  reason: string;
  expiresInDays: number;
}): ExceptionValidation {
  const rule = getRule(input.ruleId);
  if (!rule) return { ok: false, error: `Unknown rule "${input.ruleId}".` };
  if (!rule.exceptable) {
    return {
      ok: false,
      error: `${rule.id} (${rule.severity}) cannot be waived through self-service exceptions. The code must be fixed: ${rule.remediation}`
    };
  }
  if (input.reason.trim().length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      error: `A justification of at least ${MIN_REASON_LENGTH} characters is required (why is this safe, and what is the follow-up?).`
    };
  }
  const days = Math.round(input.expiresInDays);
  if (!Number.isFinite(days) || days < 1 || days > MAX_EXCEPTION_DAYS) {
    return {
      ok: false,
      error: `Exceptions must expire within 1–${MAX_EXCEPTION_DAYS} days.`
    };
  }
  return { ok: true, rule, days };
}

export interface ScanComparison {
  introduced: Finding[];
  resolved: Finding[];
  persisting: Finding[];
}

export function compareFindings(
  previous: Finding[],
  current: Finding[]
): ScanComparison {
  const prev = new Set(previous.map((f) => f.fingerprint));
  const curr = new Set(current.map((f) => f.fingerprint));
  return {
    introduced: current.filter((f) => !prev.has(f.fingerprint)),
    resolved: previous.filter((f) => !curr.has(f.fingerprint)),
    persisting: current.filter((f) => prev.has(f.fingerprint))
  };
}
