import { MAX_FILES, parseGitHubPatch } from "./diff";
import type { DiffFile } from "./types";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PrMeta {
  title: string;
  headSha: string;
  author: string;
  state: string;
  htmlUrl: string;
  changedFiles: number;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    /** False for 4xx: retrying a 404 or a private repo never helps. */
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

const PR_URL =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,7})\b/;

export function parsePrUrl(text: string): PrRef | undefined {
  const m = PR_URL.exec(text);
  if (!m) return undefined;
  return {
    owner: m[1],
    repo: m[2].replace(/\.git$/, ""),
    number: Number(m[3])
  };
}

export const prLabel = (ref: PrRef) => `${ref.owner}/${ref.repo}#${ref.number}`;
export const repoKey = (ref: PrRef) => `${ref.owner}/${ref.repo}`.toLowerCase();

async function gh<T>(path: string, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "codex-guardian",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      signal: AbortSignal.timeout(10_000)
    });
  } catch (err) {
    throw new GitHubError(`GitHub request failed: ${String(err)}`, true);
  }

  if (res.ok) return (await res.json()) as T;

  const remaining = res.headers.get("x-ratelimit-remaining");
  if ((res.status === 403 || res.status === 429) && remaining === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const mins = Math.max(1, Math.ceil((reset - Date.now()) / 60_000));
    throw new GitHubError(
      `GitHub API rate limit exhausted; resets in ~${mins} min.${token ? "" : " Configure GITHUB_TOKEN to raise the limit from 60 to 5,000 requests/hour."}`,
      false,
      res.status
    );
  }
  if (res.status === 404) {
    throw new GitHubError(
      "Pull request not found. Only public repositories are supported.",
      false,
      404
    );
  }
  throw new GitHubError(
    `GitHub API returned ${res.status}`,
    res.status >= 500,
    res.status
  );
}

export async function fetchPrMeta(ref: PrRef, token?: string): Promise<PrMeta> {
  const pr = await gh<{
    title: string;
    state: string;
    html_url: string;
    changed_files: number;
    user: { login: string } | null;
    head: { sha: string };
  }>(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token);
  return {
    title: pr.title,
    headSha: pr.head.sha,
    author: pr.user?.login ?? "unknown",
    state: pr.state,
    htmlUrl: pr.html_url,
    changedFiles: pr.changed_files
  };
}

export async function fetchPrFiles(
  ref: PrRef,
  token?: string
): Promise<{ files: DiffFile[]; notes: string[] }> {
  // One page of 100 matches MAX_FILES; larger PRs are noted, not silently cut.
  const raw = await gh<
    Array<{ filename: string; status: string; patch?: string }>
  >(
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=${MAX_FILES}`,
    token
  );
  const notes =
    raw.length >= MAX_FILES
      ? [
          `PR has ${MAX_FILES}+ files; only the first ${MAX_FILES} were scanned.`
        ]
      : [];
  return {
    files: raw.map((f) => parseGitHubPatch(f.filename, f.status, f.patch)),
    notes
  };
}
