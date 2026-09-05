import fs from "node:fs";
import path from "node:path";
import { version } from "../package.json";
import { config } from "./config";
import { configDirectory, configFilePath } from "./env";
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
model-router - Anthropic-compatible proxy for free-tier and local LLMs

Usage:
  model-router [options]

Options:
  -p, --port <number>   Port to listen on (default: 8787 or PORT env)
  -i, --init-env        Create a .env file with default configuration
  -h, --help            Show this help message
  -v, --version         Show version

Environment Variables:
  GROQ_API_KEY          API key for Groq
  GEMINI_API_KEY        API key for Google Gemini
  OPENROUTER_API_KEY    API key for OpenRouter
  LOCAL_BASE_URL        Base URL for local OpenAI-compatible endpoint (default: http://localhost:11434/v1)
  FALLBACK_ORDER        Comma-separated tier preference (default: groq,gemini,openrouter,local)
  PORT                  Port to listen on (default: 8787)
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

try {
  startServer(port);
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
