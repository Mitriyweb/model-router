import { config } from "./config";
import { log } from "./log";
import { type RequestContext, errorResponse } from "./server/http";
import { dispatchRequest } from "./server/routes";

export { parseModelTierOverride } from "./server/handlers";

export function startServer(port = config.port, hostname = config.host) {
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 60,
    async fetch(request) {
      const ctx: RequestContext = {
        request,
        url: new URL(request.url),
        params: {},
        requestId: crypto.randomUUID(),
        format: "anthropic",
      };

      try {
        return await dispatchRequest(ctx);
      } catch (err) {
        log.error("[server] unhandled request error:", String(err));
        return errorResponse(err, ctx);
      }
    },
  });

  log.info(`model-router listening on http://${hostname}:${server.port}`);
  log.info(`  Anthropic: export ANTHROPIC_BASE_URL=http://localhost:${server.port}`);
  log.info(`  OpenAI:    export OPENAI_BASE_URL=http://localhost:${server.port}/v1`);
  return server;
}
