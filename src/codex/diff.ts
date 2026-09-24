import type { DiffFile, FileStatus } from "./types";

/**
 * Hard cap on added lines kept per file. Deterministic rules are cheap, but a
 * single generated file (lockfile, snapshot) can be 50k lines and would blow
 * the Workflow step output limit (1 MiB) for no policy value.
 */
export const MAX_ADDED_LINES_PER_FILE = 2000;
export const MAX_FILES = 100;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(p: string): string {
  const trimmed = p.trim().replace(/^"|"$/g, "").split("\t")[0];
  if (trimmed === "/dev/null") return trimmed;
  return trimmed.replace(/^[ab]\//, "");
}

function newFile(path: string, status: FileStatus = "modified"): DiffFile {
  return { path, status, addedLines: [], removedCount: 0, truncated: false };
}

function isFileHeaderPair(lines: string[], i: number): boolean {
  return (
    lines[i]?.startsWith("--- ") === true &&
    lines[i + 1]?.startsWith("+++ ") === true
  );
}

/**
 * Consumes hunk bodies. Diffs pasted by humans (or written by LLMs) often have
 * wrong line counts in their `@@` headers, so we do not trust the counts to
 * decide where a hunk ends. A hunk stays open until a line that cannot be part
 * of one; counts are only used to disambiguate a removed line starting with
 * "--" (rendered "---") from the next file's header.
 */
class HunkReader {
  private open = false;
  private newLine = 0;
  private oldRemaining = 0;
  private newRemaining = 0;

  /** Returns true if lines[i] was consumed as part of a hunk. */
  consume(lines: string[], i: number, file: DiffFile): boolean {
    const raw = lines[i];
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      this.open = true;
      this.oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
      this.newLine = Number(header[3]);
      this.newRemaining = header[4] === undefined ? 1 : Number(header[4]);
      return true;
    }
    if (!this.open) return false;

    if (raw.startsWith("diff --git ")) {
      this.open = false;
      return false;
    }
    if (isFileHeaderPair(lines, i)) {
      const countsExhausted = this.oldRemaining <= 0 && this.newRemaining <= 0;
      const hunkFollows = HUNK_HEADER.test(lines[i + 2] ?? "");
      if (countsExhausted || hunkFollows) {
        this.open = false;
        return false;
      }
    }
    if (raw.startsWith("\\")) return true; // "\ No newline at end of file"

    const marker = raw[0];
    if (marker === "+") {
      if (file.addedLines.length < MAX_ADDED_LINES_PER_FILE) {
        file.addedLines.push({ line: this.newLine, text: raw.slice(1) });
      } else {
        file.truncated = true;
      }
      this.newLine++;
      this.newRemaining--;
      return true;
    }
    if (marker === "-") {
      file.removedCount++;
      this.oldRemaining--;
      return true;
    }
    // Some tools strip the leading space from blank context lines.
    if (marker === " " || raw === "") {
      this.newLine++;
      this.newRemaining--;
      this.oldRemaining--;
      return true;
    }
    this.open = false;
    return false;
  }

  close(): void {
    this.open = false;
  }
}

/**
 * Parses a unified diff (`git diff`, `git format-patch`, or plain `diff -u`
 * output) into per-file added lines with new-file line numbers.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const files: DiffFile[] = [];
  const hunks = new HunkReader();
  let current: DiffFile | undefined;
  // Set after a `diff --git` header until its `---/+++` pair or first hunk,
  // so the pair names the current file instead of starting a new one.
  let awaitingPaths = false;

  const start = (path: string): DiffFile => {
    hunks.close();
    const file = newFile(path);
    files.push(file);
    current = file;
    return file;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (current && hunks.consume(lines, i, current)) {
      awaitingPaths = false;
      continue;
    }

    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(raw);
      start(m ? m[2] : "(unknown)");
      awaitingPaths = true;
      continue;
    }

    // A "--- / +++" pair outside a hunk names the current file when it follows
    // a `diff --git` header, or starts a new file for plain `diff -u` output.
    if (isFileHeaderPair(lines, i)) {
      const oldPath = stripPrefix(raw.slice(4));
      const newPath = stripPrefix(lines[i + 1].slice(4));
      const file =
        awaitingPaths && current
          ? current
          : start(newPath === "/dev/null" ? oldPath : newPath);
      awaitingPaths = false;
      if (oldPath === "/dev/null") {
        file.status = "added";
        file.path = newPath;
      } else if (newPath === "/dev/null") {
        file.status = "removed";
        file.path = oldPath;
      } else {
        file.path = newPath;
        if (oldPath !== newPath && file.status === "modified") {
          file.status = "renamed";
        }
      }
      i++;
      continue;
    }

    if (!current) {
      // Hunks with no file header at all: attribute them to an unnamed file
      // rather than silently dropping them.
      if (HUNK_HEADER.test(raw)) hunks.consume(lines, i, start("(unnamed)"));
      continue;
    }

    if (raw.startsWith("new file mode")) current.status = "added";
    else if (raw.startsWith("deleted file mode")) current.status = "removed";
    else if (raw.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = raw.slice("rename to ".length).trim();
    } else if (
      raw.startsWith("Binary files ") ||
      raw.startsWith("GIT binary patch")
    ) {
      current.truncated = true;
    }
  }

  return files
    .filter((f) => f.path && f.path !== "/dev/null")
    .slice(0, MAX_FILES);
}

/**
 * Parses a GitHub "files" API entry, whose `patch` contains hunks only
 * (no file headers). `patch` is absent for binary or very large files.
 */
export function parseGitHubPatch(
  path: string,
  githubStatus: string,
  patch: string | undefined
): DiffFile {
  const status: FileStatus =
    githubStatus === "added" ||
    githubStatus === "removed" ||
    githubStatus === "renamed"
      ? githubStatus
      : "modified";
  const file = newFile(path, status);
  if (patch === undefined) {
    file.truncated = true;
    return file;
  }
  const hunks = new HunkReader();
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) hunks.consume(lines, i, file);
  return file;
}

/** Heuristic: does this text contain a unified diff worth scanning? */
export function looksLikeDiff(text: string): boolean {
  if (/^diff --git /m.test(text)) return true;
  return (
    /^--- \S/m.test(text) && /^\+\+\+ \S/m.test(text) && /^@@ -\d/m.test(text)
  );
}

/** Extracts the diff portion of a chat message (drops any prose around it). */
export function extractDiff(text: string): string | undefined {
  if (!looksLikeDiff(text)) return undefined;
  const fenced = /```(?:diff|patch)?\n([\s\S]*?)```/.exec(text);
  if (fenced && looksLikeDiff(fenced[1])) return fenced[1];
  const startIdx = text.search(/^(diff --git |--- \S)/m);
  return startIdx >= 0 ? text.slice(startIdx) : text;
}

/**
 * Builds a well-formed unified diff from full new-file contents. Used by the
 * eval suite and the UI's sample loader, so hand-authored cases never have
 * wrong hunk counts.
 */
export function synthesizeDiff(
  files: Array<{ path: string; status?: "added" | "modified"; content: string }>
): string {
  return files
    .map(({ path, status = "added", content }) => {
      const body = content.replace(/\r\n?/g, "\n").replace(/\n$/, "");
      const lines = body.split("\n");
      const header =
        status === "added"
          ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@`
          : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,${lines.length} @@`;
      return `${header}\n${lines.map((l) => `+${l}`).join("\n")}`;
    })
    .join("\n");
}
