import { parseUnifiedDiff } from "./codex/diff";
import { scanFiles } from "./codex/engine";
import {
  fetchPrFiles,
  fetchPrMeta,
  parsePrUrl,
  prLabel,
  repoKey
} from "./codex/github";
import { workersAiClient } from "./codex/llm";
import type { ScanResult } from "./codex/types";
import { MAX_DIFF_CHARS, type ScanTarget } from "./shared";

export class InputError extends Error {}

export interface ScanOnceInput {
  diff?: string;
  prUrl?: string;
  /** Default true. False runs deterministic rules only (fast, free). */
  ai?: boolean;
}

/**
 * Synchronous scan without memory, for the HTTP API and the MCP server. The
 * caller holds the connection for the whole scan (typically 5–40s).
 */
export async function scanOnce(
  env: Env,
  input: ScanOnceInput
): Promise<{ target: ScanTarget; result: ScanResult }> {
  let target: ScanTarget;
  let files;
  const notes: string[] = [];

  if (input.prUrl) {
    const ref = parsePrUrl(input.prUrl);
    if (!ref)
      throw new InputError(
        "prUrl must look like https://github.com/owner/repo/pull/123"
      );
    const [meta, loaded] = await Promise.all([
      fetchPrMeta(ref, env.GITHUB_TOKEN),
      fetchPrFiles(ref, env.GITHUB_TOKEN)
    ]);
    files = loaded.files;
    notes.push(...loaded.notes);
    target = {
      kind: "pr",
      label: prLabel(ref),
      repo: repoKey(ref),
      url: meta.htmlUrl,
      headSha: meta.headSha,
      prTitle: meta.title
    };
  } else if (input.diff) {
    if (input.diff.length > MAX_DIFF_CHARS) {
      throw new InputError(`Diff exceeds ${MAX_DIFF_CHARS} characters.`);
    }
    files = parseUnifiedDiff(input.diff);
    target = { kind: "diff", label: "pasted-diff", repo: "pasted-diff" };
  } else {
    throw new InputError("Provide either `diff` or `prUrl`.");
  }

  if (files.length === 0)
    throw new InputError("No file changes found in the input.");

  const result = await scanFiles(files, {
    now: new Date(),
    llm: input.ai === false ? undefined : workersAiClient(env.AI)
  });
  result.notes.unshift(...notes);
  return { target, result };
}
