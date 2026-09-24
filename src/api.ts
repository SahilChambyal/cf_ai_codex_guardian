import { z } from "zod";
import { GitHubError } from "./codex/github";
import { RULES, describeRule } from "./codex/rules";
import { InputError, scanOnce } from "./scan-once";
import { MAX_DIFF_CHARS } from "./shared";

const scanBody = z
  .object({
    diff: z.string().max(MAX_DIFF_CHARS).optional(),
    prUrl: z.string().max(300).optional(),
    ai: z.boolean().optional()
  })
  .refine((b) => Boolean(b.diff) !== Boolean(b.prUrl), {
    message: "Provide exactly one of `diff` or `prUrl`."
  });

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  });

export const clientIp = (request: Request) =>
  request.headers.get("cf-connecting-ip") ?? "unknown";

const bearerMatches = (request: Request, token: string) =>
  request.headers.get("authorization") === `Bearer ${token}`;

/**
 * Optional shared-secret gate for machine clients (CI, evals, MCP). With no
 * SCAN_API_TOKEN configured the API is open (demo mode) and rate limited.
 */
export function authorized(request: Request, env: Env): boolean {
  return !env.SCAN_API_TOKEN || bearerMatches(request, env.SCAN_API_TOKEN);
}

/** Token holders are trusted callers (CI, eval suite) and skip the IP limit. */
export async function withinRateLimit(
  request: Request,
  env: Env
): Promise<boolean> {
  if (env.SCAN_API_TOKEN && bearerMatches(request, env.SCAN_API_TOKEN))
    return true;
  const { success } = await env.SCAN_LIMITER.limit({
    key: `ip:${clientIp(request)}`
  });
  return success;
}

/**
 * Stateless HTTP API. Used by CI (fail a build on findings), the eval suite,
 * and anyone who wants results without the chat UI.
 *
 *   GET  /api/rules
 *   POST /api/scan   { diff } | { prUrl }, optional { ai: false }
 */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/rules" && request.method === "GET") {
    return json({ rules: RULES.map(describeRule) });
  }

  if (pathname === "/api/scan") {
    if (request.method !== "POST") return json({ error: "Use POST" }, 405);
    if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);

    if (!(await withinRateLimit(request, env))) {
      return json({ error: "Rate limit exceeded; retry in a minute." }, 429);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Body must be JSON." }, 400);
    }
    const parsed = scanBody.safeParse(body);
    if (!parsed.success) {
      return json(
        { error: parsed.error.issues.map((i) => i.message).join("; ") },
        400
      );
    }

    try {
      const { target, result } = await scanOnce(env, parsed.data);
      const blocking = result.findings.filter(
        (f) => f.severity === "critical" || f.severity === "high"
      ).length;
      return json({
        target,
        ...result,
        summary: { total: result.findings.length, blocking }
      });
    } catch (err) {
      if (err instanceof InputError) return json({ error: err.message }, 400);
      if (err instanceof GitHubError) {
        return json({ error: err.message }, err.status === 404 ? 404 : 502);
      }
      console.error("scan failed", err);
      return json({ error: "Scan failed unexpectedly." }, 500);
    }
  }

  return json({ error: "Not found" }, 404);
}
