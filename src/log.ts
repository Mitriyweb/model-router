/**
 * Leveled logger with a single `LOG_LEVEL` switch (`debug` | `info` | `warn` |
 * `error` | `silent`, default `info`).
 *
 * The env var is read lazily so the logger works before `config.ts` loads
 * `.env` files. Calls still go through the console methods, which keeps test
 * spies working.
 */

type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

function enabled(level: LogLevel): boolean {
  return LEVELS[level] >= threshold();
}

export const log = {
  debug(...args: unknown[]) {
    if (enabled("debug")) console.debug(...args);
  },
  info(...args: unknown[]) {
    if (enabled("info")) console.log(...args);
  },
  warn(...args: unknown[]) {
    if (enabled("warn")) console.warn(...args);
  },
  error(...args: unknown[]) {
    if (enabled("error")) console.error(...args);
  },
};
