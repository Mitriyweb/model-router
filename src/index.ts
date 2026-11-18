import fs from "node:fs";
import path from "node:path";
import { version } from "../package.json";
import { config } from "./config";
import { configDirectory, configFilePath } from "./env";
import { rateLimiter } from "./rateLimiter";
import { startServer } from "./server";

function initEnvFile() {
  const envExamplePaths = [
    path.join(configDirectory, ".env.example"),
    path.join(process.cwd(), ".env.example"),
  ];
  const envExamplePath = envExamplePaths.find((filePath) => fs.existsSync(filePath));

  if (fs.existsSync(configFilePath)) {
    console.log(".env file already exists at:", configFilePath);
    return;
  }

  if (!envExamplePath) {
    console.error(
      `Could not find .env.example next to the binary (${configDirectory}) or in the current directory (${process.cwd()}).`,
    );
    process.exit(1);
  }

  try {
    fs.copyFileSync(envExamplePath, configFilePath);
    console.log(".env file created at:", configFilePath);
    console.log("Please edit the file with your actual configuration values.");
  } catch (err) {
    console.error("Failed to create .env file:", err);
    process.exit(1);
  }
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
model-router - Universal proxy with Anthropic and OpenAI APIs for 10 free-tier and local LLM providers

Usage:
  model-router [options]

Options:
  -p, --port <number>   Port to listen on (default: 8787 or PORT env)
  -H, --host <address>  Bind address (default: 127.0.0.1 or ROUTER_HOST env)
  -i, --init-env        Create a .env file with default configuration
  -h, --help            Show this help message
  -v, --version         Show version

Provider credentials (set the ones you use; see .env.example for all options):
  CEREBRAS_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY,
  MISTRAL_API_KEY, NVIDIA_API_KEY, HF_API_KEY, COHERE_API_KEY,
  CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, LOCAL_BASE_URL

Router settings:
  FALLBACK_ORDER             Comma-separated tier preference
  ROUTER_STRICT_FALLBACK_ORDER  Fail on unknown tiers instead of skipping them
  PORT                       Port to listen on (default: 8787)
  ROUTER_HOST                Bind address (default: 127.0.0.1)
  LOG_LEVEL                  debug | info | warn | error | silent (default: info)
  ROUTER_AUTH_TOKEN          Bearer token required for /reset endpoints
  ROUTER_DISABLE_CACHE       Disable the exact-repeat cache (true/false)
  ROUTER_CACHE_TTL_MS        Cache entry TTL (default: 600000)
  ROUTER_CACHE_MAX_ENTRIES   Cache size limit (default: 500)
  ROUTER_MAX_BODY_BYTES      Request body cap (default: 1048576)
  ROUTER_CORS_ORIGIN         Allowed CORS origin (empty disables CORS)
  ROUTER_MAX_CONTEXT_TOKENS  Hard context cap (default: 128000)
  RATE_LIMIT_STATE_FILE      Rate-limiter state file (default: .router-state.json)

Endpoints:
  Anthropic: POST /v1/messages          OpenAI: POST /v1/chat/completions
  GET /v1/models, /v1/providers, /status, /health
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(`model-router v${version}`);
  process.exit(0);
}

if (args.includes("--init-env") || args.includes("-i")) {
  initEnvFile();
  process.exit(0);
}

let port = config.port;
const portIndex = args.findIndex((a) => a === "-p" || a === "--port");
if (portIndex !== -1 && args[portIndex + 1]) {
  port = Number(args[portIndex + 1]);
}

let host = config.host;
const hostIndex = args.findIndex((a) => a === "-H" || a === "--host");
const hostArg = hostIndex === -1 ? undefined : args[hostIndex + 1];
if (hostArg) {
  host = hostArg;
}

await rateLimiter.ready();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await rateLimiter.saveImmediately();
    process.exit(0);
  });
}

try {
  startServer(port, host);
} catch (err) {
  const error = err as { code?: string; message?: string };

  if (error.code === "EADDRINUSE" || error.message?.includes("EADDRINUSE")) {
    console.error(`Cannot start model-router: port ${port} is already in use.`);
    console.error(`Use another port: model-router --port ${port + 1}`);
    console.error(`Find the process using it: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
