/**
 * Stable public entry point for the routing pipeline.
 *
 * The implementation lives in `routing/router.ts`; this module keeps the
 * original import path and named exports working for callers and tests.
 */
export {
  estimateTokens,
  retryAfterFromError,
  retryAfterFromHeaders,
  routeRequest,
  routeRequestStream,
  type RouteResult,
  type StreamRouteResult,
} from "./routing/router";
export { planTierOrder } from "./routing/planner";
export type { RouteOptions } from "./routing/planner";
export { hasCredentials } from "./providers";
