import { routeAgentRequest } from "agents";
import { authorized, clientIp, handleApi, withinRateLimit } from "./api";
import { handleMcp } from "./mcp";

export { CodexAgent } from "./agent";
export { ReviewWorkflow } from "./workflow";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith("/api/")) return handleApi(request, env);

    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      if (!authorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (!(await withinRateLimit(request, env))) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
      return handleMcp(request, env, ctx);
    }

    if (pathname.startsWith("/agents/")) {
      // Caps WebSocket connects / HTTP calls per IP; per-workspace chat and
      // scan limits are enforced inside the agent.
      const { success } = await env.CHAT_LIMITER.limit({
        key: `ip:${clientIp(request)}`
      });
      if (!success) return new Response("Rate limit exceeded", { status: 429 });
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
