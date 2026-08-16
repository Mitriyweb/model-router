import { cacheKey, getCached } from "../cache";
import type { AnthropicResponse, NormalizedRequest } from "../types";

export type ResolverFn = (req: NormalizedRequest) => Promise<AnthropicResponse | null>;

export const resolvers: Record<string, ResolverFn> = {
  cache: async (req: NormalizedRequest): Promise<AnthropicResponse | null> => {
    const key = await cacheKey(req);
    const cached = getCached(key);
    if (!cached) return null;
    return {
      ...cached,
      id: crypto.randomUUID(),
    };
  },
};
