/**
 * Identity of a finding across scans. Keyed on the offending line's content
 * rather than its line number, so a finding survives unrelated edits above it
 * and "resolved vs. still present" comparisons stay meaningful.
 */
export function fingerprint(
  ruleId: string,
  file: string,
  evidenceOrLine: string | number | undefined
): string {
  const key = `${ruleId}|${file}|${String(evidenceOrLine ?? "").trim()}`;
  // FNV-1a 32-bit: short, stable, dependency-free. Collisions only merge two
  // findings of the same rule in the same file, which is acceptable here.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${ruleId}:${(h >>> 0).toString(16).padStart(8, "0")}`;
}
