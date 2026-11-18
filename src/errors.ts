import type { TierName } from "./types";

/** Safely read an error message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

export class ProviderError extends Error {
  status: number;
  headers?: Headers;

  constructor(message: string, status: number, headers?: Headers) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.headers = headers;
  }
}

export interface RouteAttempt {
  tier: TierName;
  skipped?: string;
  error?: string;
}

export class AllTiersFailedError extends Error {
  readonly attempts: RouteAttempt[];

  constructor(attempts: RouteAttempt[]) {
    super(`All tiers exhausted or unavailable: ${JSON.stringify(attempts, null, 2)}`);
    this.name = "AllTiersFailedError";
    this.attempts = attempts;
  }
}
