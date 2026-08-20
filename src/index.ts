#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { startServer } from "./server";

function initEnvFile() {
  const envPath = path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".model-router.env",
  );
  const envExamplePath = path.join(path.dirname(process.execPath), ".env.example");

  if (fs.existsSync(envPath)) {
    console.log(".env file already exists at:", envPath);
    return;
  }

  if (!fs.existsSync(envExamplePath)) {
    console.error(".env.example file not found. Please ensure it exists in the project root.");
    process.exit(1);
  }

  try {
    fs.copyFileSync(envExamplePath, envPath);
    console.log(".env file created at:", envPath);
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
  console.log(`model-router v${require("./package.json").version}`);
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

startServer(port);
