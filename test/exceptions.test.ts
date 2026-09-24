import { describe, expect, it } from "vitest";
import {
  applyExceptions,
  compareFindings,
  validateExceptionRequest,
  type ExceptionRecord
} from "../src/codex/exceptions";
import { fingerprint } from "../src/codex/fingerprint";
import { parsePrUrl } from "../src/codex/github";
import type { Finding } from "../src/codex/types";
import { formatScanAnnouncement } from "../src/summary";
import { emptyCounts, type ScanSummary } from "../src/shared";

const NOW = 1_800_000_000_000;

const finding = (ruleId: string, evidence: string): Finding => ({
  fingerprint: fingerprint(ruleId, "a.ts", evidence),
  ruleId,
  severity: "high",
  file: "a.ts",
  line: 1,
  message: `${ruleId} hit`,
  source: "deterministic",
  evidence
});

const exc = (over: Partial<ExceptionRecord> = {}): ExceptionRecord => ({
  id: "exc-1",
  repo: "acme/api",
  ruleId: "CX-CI-001",
  reason: "Vendor action has no releases; tracked in JIRA-123.",
  createdAt: NOW - 1000,
  expiresAt: NOW + 86_400_000,
  revokedAt: null,
  ...over
});

describe("applyExceptions", () => {
  const findings = [
    finding("CX-CI-001", "uses: x@v1"),
    finding("CX-TLS-001", "verify=False")
  ];

  it("suppresses only the excepted rule in the excepted repo (case-insensitive)", () => {
    const out = applyExceptions(findings, [exc()], "Acme/API", NOW);
    expect(out.map((f) => f.suppressedBy)).toEqual(["exc-1", undefined]);
    expect(
      applyExceptions(findings, [exc()], "other/repo", NOW).every(
        (f) => !f.suppressedBy
      )
    ).toBe(true);
  });

  it("ignores expired and revoked exceptions", () => {
    expect(
      applyExceptions(
        findings,
        [exc({ expiresAt: NOW - 1 })],
        "acme/api",
        NOW
      )[0].suppressedBy
    ).toBeUndefined();
    expect(
      applyExceptions(
        findings,
        [exc({ revokedAt: NOW - 1 })],
        "acme/api",
        NOW
      )[0].suppressedBy
    ).toBeUndefined();
  });
});

describe("validateExceptionRequest", () => {
  const ok = {
    ruleId: "cx-ci-001",
    reason: "Vendor action has no tagged releases yet.",
    expiresInDays: 30
  };

  it("accepts a well-formed request and normalizes the rule id", () => {
    const res = validateExceptionRequest(ok);
    expect(res.ok && res.rule.id).toBe("CX-CI-001");
  });

  it("refuses non-exceptable rules, short reasons, and out-of-range durations", () => {
    expect(
      validateExceptionRequest({ ...ok, ruleId: "CX-SEC-001" })
    ).toMatchObject({ ok: false });
    expect(
      validateExceptionRequest({ ...ok, ruleId: "CX-NOPE" })
    ).toMatchObject({ ok: false });
    expect(
      validateExceptionRequest({ ...ok, reason: "because" })
    ).toMatchObject({ ok: false });
    expect(validateExceptionRequest({ ...ok, expiresInDays: 0 })).toMatchObject(
      { ok: false }
    );
    expect(
      validateExceptionRequest({ ...ok, expiresInDays: 365 })
    ).toMatchObject({ ok: false });
  });
});

describe("compareFindings", () => {
  it("classifies by content fingerprint, independent of line numbers", () => {
    const a = finding("CX-CI-001", "uses: x@v1");
    const moved = { ...finding("CX-CI-001", "uses: x@v1"), line: 40 };
    const fixed = finding("CX-TLS-001", "verify=False");
    const added = finding("CX-DEP-001", '"lodash": "^4"');
    const res = compareFindings([a, fixed], [moved, added]);
    expect(res.introduced.map((f) => f.ruleId)).toEqual(["CX-DEP-001"]);
    expect(res.resolved.map((f) => f.ruleId)).toEqual(["CX-TLS-001"]);
    expect(res.persisting.map((f) => f.ruleId)).toEqual(["CX-CI-001"]);
  });
});

describe("parsePrUrl", () => {
  it("extracts PR refs from text and rejects non-PR URLs", () => {
    expect(
      parsePrUrl(
        "scan https://github.com/cloudflare/workers-sdk/pull/1234 please"
      )
    ).toEqual({
      owner: "cloudflare",
      repo: "workers-sdk",
      number: 1234
    });
    expect(
      parsePrUrl("https://github.com/cloudflare/workers-sdk/issues/1")
    ).toBeUndefined();
    expect(parsePrUrl("https://gitlab.com/a/b/pull/1")).toBeUndefined();
  });
});

describe("formatScanAnnouncement", () => {
  const scan: ScanSummary = {
    id: "scan-1",
    target: { kind: "diff", label: "pasted-diff", repo: "pasted-diff" },
    status: "complete",
    createdAt: NOW,
    completedAt: NOW,
    counts: emptyCounts(),
    suppressed: 0,
    progress: null,
    error: null,
    notes: [],
    stats: null
  };

  it("never declares a partially scanned change clean", () => {
    expect(formatScanAnnouncement(scan, [])).toContain(
      "No Codex violations found."
    );
    const partial = formatScanAnnouncement(
      { ...scan, notes: ["1 of 2 AI review batch(es) failed"] },
      []
    );
    expect(partial).not.toContain("No Codex violations found.");
    expect(partial).toContain("in the parts that were scanned");
  });

  it("escapes table-breaking characters from findings", () => {
    const f = { ...finding("CX-CI-001", "x"), message: "a | b" };
    const text = formatScanAnnouncement(
      { ...scan, counts: { ...emptyCounts(), high: 1 } },
      [f]
    );
    expect(text).toContain("a \\| b");
  });
});
