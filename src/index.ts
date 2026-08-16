#!/usr/bin/env bun
import { config } from "./config";
import { startServer } from "./server";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
model-router - Anthropic-compatible proxy for free-tier and local LLMs

Usage:
  model-router [options]

Options:
  -p, --port <number>   Port to listen on (default: 8787 or PORT env)
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
  console.log("model-router v0.1.0");
  process.exit(0);
}

let port = config.port;
const portIndex = args.findIndex((a) => a === "-p" || a === "--port");
if (portIndex !== -1 && args[portIndex + 1]) {
  port = Number(args[portIndex + 1]);
}

startServer(port);
