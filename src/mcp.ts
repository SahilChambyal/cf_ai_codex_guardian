import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { RULES, describeRule } from "./codex/rules";
import { scanOnce } from "./scan-once";
import { MAX_DIFF_CHARS } from "./shared";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
});

const failure = (err: unknown) => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text: err instanceof Error ? err.message : String(err)
    }
  ]
});

/**
 * Exposes the same checks to coding agents (Claude Code, Cursor, …) so a
 * developer's agent can self-check a change before a human ever sees it.
 * Stateless: the memory/exceptions workflow lives in the chat agent.
 */
function createServer(env: Env) {
  const server = new McpServer({ name: "codex-guardian", version: "1.0.0" });

  server.registerTool(
    "codex_list_rules",
    {
      description:
        "List the Engineering Codex rules this server enforces, with rationale and remediation.",
      inputSchema: {}
    },
    async () => text(RULES.map(describeRule))
  );

  server.registerTool(
    "codex_check_diff",
    {
      description:
        "Check a unified diff (git diff output) against the Engineering Codex. Returns findings with rule IDs, file:line, and messages. Run this before opening a pull request.",
      inputSchema: {
        diff: z.string().max(MAX_DIFF_CHARS).describe("Unified diff text"),
        ai: z
          .boolean()
          .optional()
          .describe("Run AI-judged rules too (slower). Default true.")
      }
    },
    async ({ diff, ai }) => {
      try {
        const { result } = await scanOnce(env, { diff, ai });
        return text(result);
      } catch (err) {
        return failure(err);
      }
    }
  );

  server.registerTool(
    "codex_check_pull_request",
    {
      description:
        "Check a public GitHub pull request against the Engineering Codex.",
      inputSchema: {
        url: z
          .string()
          .max(300)
          .describe("https://github.com/owner/repo/pull/123")
      }
    },
    async ({ url }) => {
      try {
        const { target, result } = await scanOnce(env, { prUrl: url });
        return text({ target, ...result });
      } catch (err) {
        return failure(err);
      }
    }
  );

  return server;
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext) {
  // A fresh server per request: the MCP SDK refuses to reconnect a server.
  return createMcpHandler(createServer(env), { route: "/mcp" })(
    request,
    env,
    ctx
  );
}
