import type { ReviewedFinding } from "./codex/exceptions";
import type { ScanSummary } from "./shared";

const MAX_ROWS = 10;

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * The chat message posted when a scan finishes. Generated deterministically
 * from stored results, not by the model, so the announcement can never
 * contain an invented finding or wrongly declare a change clean.
 */
export function formatScanAnnouncement(
  scan: ScanSummary,
  findings: ReviewedFinding[]
): string {
  const t = scan.target;
  const title =
    t.kind === "pr"
      ? `[${t.label}](${t.url})${t.headSha ? ` @ \`${t.headSha.slice(0, 7)}\`` : ""}${t.prTitle ? ` — ${cell(t.prTitle)}` : ""}`
      : `\`${t.label}\``;
  const stats = scan.stats
    ? ` · ${scan.stats.filesScanned} file(s), ${scan.stats.addedLines} added line(s) · ${(scan.stats.durationMs / 1000).toFixed(1)}s`
    : "";

  const lines = [`**Scan complete** · ${title}${stats}`, ""];
  const active = findings.filter((f) => !f.suppressedBy);
  const c = scan.counts;

  if (active.length === 0) {
    lines.push(
      scan.notes.length > 0
        ? "No violations found **in the parts that were scanned** — see coverage notes below."
        : "No Codex violations found."
    );
  } else {
    lines.push(
      `**${active.length} finding(s)**: ${c.critical} critical · ${c.high} high · ${c.medium} medium · ${c.low} low` +
        (scan.suppressed > 0
          ? ` · ${scan.suppressed} waived by exception`
          : ""),
      "",
      "| Severity | Rule | Location | Finding |",
      "|---|---|---|---|",
      ...active
        .slice(0, MAX_ROWS)
        .map(
          (f) =>
            `| ${f.severity} | ${f.ruleId} | \`${cell(f.file)}${f.line ? `:${f.line}` : ""}\` | ${cell(f.message)} |`
        )
    );
    if (active.length > MAX_ROWS) {
      lines.push(
        "",
        `…and ${active.length - MAX_ROWS} more in the findings panel.`
      );
    }
  }

  if (scan.notes.length > 0) {
    lines.push("", ...scan.notes.map((n) => `> ⚠️ ${n}`));
  }
  lines.push(
    "",
    "Ask me to explain a finding, compare with the previous scan, or request a time-boxed exception."
  );
  return lines.join("\n");
}

export function formatScanFailure(scan: ScanSummary): string {
  return `**Scan failed** · \`${scan.target.label}\`\n\n${scan.error ?? "Unknown error."}`;
}
