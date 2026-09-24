// Secrets are not emitted by `wrangler types` unless present in .dev.vars,
// so declare the optional ones by merging into the generated base Env
// (both the global `Env` and `Cloudflare.Env` extend it).
interface __BaseEnv_Env {
  /** Read-only token; raises the GitHub API limit from 60 to 5,000 req/h. */
  GITHUB_TOKEN?: string;
  /** When set, /api/scan and /mcp require `Authorization: Bearer <token>`. */
  SCAN_API_TOKEN?: string;
}
