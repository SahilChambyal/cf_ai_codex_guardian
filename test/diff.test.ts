import { describe, expect, it } from "vitest";
import {
  extractDiff,
  looksLikeDiff,
  parseGitHubPatch,
  parseUnifiedDiff,
  synthesizeDiff
} from "../src/codex/diff";

const GIT_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,4 +10,5 @@ export function main() {
   const a = 1;
-  const b = 2;
+  const b = 3;
+  const c = 4;
   return a + b;
 }
diff --git a/README.md b/README.md
new file mode 100644
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# Title
+Body
`;

describe("parseUnifiedDiff", () => {
  it("tracks new-file line numbers across context and removals", () => {
    const [app, readme] = parseUnifiedDiff(GIT_DIFF);
    expect(app.path).toBe("src/app.ts");
    expect(app.status).toBe("modified");
    expect(app.addedLines).toEqual([
      { line: 11, text: "  const b = 3;" },
      { line: 12, text: "  const c = 4;" }
    ]);
    expect(app.removedCount).toBe(1);
    expect(readme.status).toBe("added");
    expect(readme.addedLines.map((l) => l.line)).toEqual([1, 2]);
  });

  it("does not mistake a removed line starting with '--' for a file header", () => {
    const diff = `diff --git a/x.sql b/x.sql
--- a/x.sql
+++ b/x.sql
@@ -1,2 +1,2 @@
--- old comment
+++ new comment
 select 1;
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("x.sql");
    expect(files[0].removedCount).toBe(1);
    expect(files[0].addedLines).toEqual([{ line: 1, text: "++ new comment" }]);
  });

  it("tolerates hunk headers whose counts are wrong (hand-written diffs)", () => {
    const diff = `--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
+one
+two
+three
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
+other
`;
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(files[0].addedLines).toHaveLength(3);
    expect(files[1].addedLines).toEqual([{ line: 1, text: "other" }]);
  });

  it("handles deletions, renames, binary files, CRLF and no-newline markers", () => {
    const diff = [
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/a.ts b/b.ts",
      "similarity index 90%",
      "rename from a.ts",
      "rename to b.ts",
      "--- a/a.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "\\ No newline at end of file",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ"
    ].join("\r\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["old.ts", "removed"],
      ["b.ts", "renamed"],
      ["logo.png", "modified"]
    ]);
    expect(files[1].addedLines).toEqual([{ line: 1, text: "y" }]);
    expect(files[2].truncated).toBe(true);
  });

  it("returns nothing for prose", () => {
    expect(parseUnifiedDiff("hello, can you review my code?")).toEqual([]);
  });
});

describe("parseGitHubPatch", () => {
  it("parses hunk-only patches", () => {
    const f = parseGitHubPatch(
      "a.go",
      "modified",
      "@@ -3,2 +3,3 @@\n x\n+y\n z"
    );
    expect(f.addedLines).toEqual([{ line: 4, text: "y" }]);
  });

  it("marks files without a patch as truncated", () => {
    const f = parseGitHubPatch("big.bin", "added", undefined);
    expect(f).toMatchObject({
      status: "added",
      truncated: true,
      addedLines: []
    });
  });
});

describe("diff detection", () => {
  it("detects diffs and extracts them from chat messages", () => {
    const msg = `Please review this:\n\`\`\`diff\n${GIT_DIFF}\`\`\`\nthanks`;
    expect(looksLikeDiff(msg)).toBe(true);
    expect(extractDiff(msg)?.startsWith("diff --git")).toBe(true);
    expect(looksLikeDiff("--- is a markdown rule\n+++ not a diff")).toBe(false);
  });

  it("synthesizeDiff round-trips through the parser", () => {
    const diff = synthesizeDiff([
      { path: "a.ts", content: "one\ntwo\n" },
      { path: "b.ts", status: "modified", content: "three" }
    ]);
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.path, f.status, f.addedLines.length])).toEqual([
      ["a.ts", "added", 2],
      ["b.ts", "modified", 1]
    ]);
  });
});
