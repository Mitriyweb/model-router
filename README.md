# model-router

Universal AI proxy that allows **Claude Code**, **Agent Team**, **ZeroClaw**, **Aider**, **Cline (Roo Code)**, **Cursor**, **mini-agent**, and custom Chat UIs to run on **10 free-tier and local LLM providers** instead of expensive paid APIs.

## Supported Providers

| Provider | Free Tier Limit | API Type | Best For |
|---|---|---|---|
| **Cerebras** | Trial: 1M+ tokens / day | OpenAI-compatible | Ultra-fast Llama-3.3-70b batch processing |
| **Groq** | 30 RPM / 6k TPM / 14.4k RPD | OpenAI-compatible | Instant streaming and fast tool calling |
| **Google Gemini** | 15 RPM / 1M TPM / 1.5k RPD | Gemini API | Large context windows (>4k tokens) |
| **OpenRouter** | 20 RPM / 50 RPD (free models) | OpenAI-compatible | Broad selection of open models |
| **Mistral AI** | 2 RPM / 500k TPM / ~1B tpm/mo | OpenAI-compatible | Codestral & Mistral Large |
| **NVIDIA NIM** | 40 RPM / 1,000 requests | OpenAI-compatible | 90+ models (Llama, DeepSeek, Phi) |
| **Hugging Face** | Varies by upstream provider | OpenAI-compatible | Access models via HF Inference Providers (Groq, Cerebras, Together, etc.) |
| **Cloudflare AI** | 60 RPM / 10k RPD | Cloudflare AI | Serverless edge inference |
| **Cohere** | 10 RPM / 100 RPD | Cohere Chat v2 | Command R+ with advanced RAG & tool-use |
| **Local (Ollama)** | Unlimited | OpenAI-compatible | Fully offline & private execution |

---

## Dual API Architecture

`model-router` simultaneously exposes two standard APIs on port `8787`:

1. **Anthropic API** (`POST /v1/messages`): For Claude Code, Agent Team, and Anthropic clients.
2. **OpenAI API** (`POST /v1/chat/completions` & `GET /v1/models`): For ZeroClaw, Aider, Cline, Roo Code, Cursor, Continue.dev, mini-agent, and Web Chat interfaces.

Both endpoints accept compressed request bodies — send `Content-Encoding: gzip`, `deflate`, or `br` with a compressed JSON payload to reduce upload size on large prompts. Decompressed bodies are capped by `ROUTER_MAX_BODY_BYTES` (default: 1 MiB).

---

## Endpoints & Runtime Configuration

| Endpoint | Purpose |
|---|---|
| `POST /v1/messages` | Anthropic Messages API |
| `POST /v1/chat/completions` | OpenAI Chat Completions API |
| `GET /v1/models` | OpenAI-style model list |
| `GET /v1/providers` | Provider registry with credentials/status |
| `GET /status` | Per-tier rate-limit snapshot and cache statistics |
| `GET /health` | Health check |
| `POST /reset`, `/reset-state`, `/v1/reset` | Reset rate-limiter state (requires `ROUTER_AUTH_TOKEN`) |

Per-provider routes are also available: `POST /v1/providers/{provider}/messages` and `POST /v1/providers/{provider}/chat/completions`, where `{provider}` is any registered tier (for example `groq`). The same tier can be selected with the `x-router-provider` / `x-router-tier` header or with a provider-prefixed model name such as `groq/llama-3.3-70b-versatile`. `x-router-private: true` restricts routing to the local tier, and `x-router-auth-token` is accepted on the reset endpoints. Every response carries `x-request-id` and `x-router-tier`.

Copy `.env.example` to `.env` to configure providers and router behavior. The generated example is the source of truth for all supported variables; the most relevant router settings are `FALLBACK_ORDER`, `ROUTER_STRICT_FALLBACK_ORDER`, `ROUTER_DISABLE_CACHE`, `ROUTER_CACHE_TTL_MS`, `ROUTER_CACHE_MAX_ENTRIES`, `ROUTER_HOST`, `PORT`, `ROUTER_AUTH_TOKEN`, `ROUTER_MAX_BODY_BYTES`, `ROUTER_CORS_ORIGIN`, `ROUTER_MAX_CONTEXT_TOKENS`, and `RATE_LIMIT_STATE_FILE`. Run `model-router --help` for a compact reference.

---

[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Visit-blue)](https://mitriyweb.github.io/model-router)

## Quick Install

Install `model-router` binary with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/Mitriyweb/model-router/main/install.sh | bash
```

To create a user configuration file with default values, run:

```bash
model-router --init-env
```

This creates `.env` next to the installed binary. It is loaded automatically when `model-router` starts, regardless of the current working directory.

Or run via Bun:

```bash
git clone https://github.com/Mitriyweb/model-router.git
cd model-router
cp .env.example .env
bun install
bun run start
```

---

## Client Setup & Integrations

### 1. Claude Code

```bash
ANTHROPIC_BASE_URL=http://localhost:8787 ANTHROPIC_API_KEY=dummy claude
```

> **Alias Tip:** Add to your `~/.zshrc`:
> ```bash
> echo 'alias claude-free="ANTHROPIC_BASE_URL=http://localhost:8787 ANTHROPIC_API_KEY=dummy claude"' >> ~/.zshrc
> ```

---

### 2. Agent Team

[Agent Team](https://github.com/Mitriyweb/agent-team) connects via the Anthropic API:

```bash
export ANTHROPIC_BASE_URL="http://localhost:8787"
export ANTHROPIC_API_KEY="dummy"
agent-team run --all
```

---

### 3. ZeroClaw & Claw Analogs

ZeroClaw connects directly via the OpenAI Chat Completions endpoint:

```bash
export OPENAI_BASE_URL="http://localhost:8787/v1"
export OPENAI_API_KEY="dummy"
zeroclaw --model model-router-auto
```

---

### 4. Aider

```bash
export OPENAI_API_BASE="http://localhost:8787/v1"
export OPENAI_API_KEY="dummy"
aider --model openai/model-router-auto
```

---

### 5. Cline / Roo Code / Continue.dev / Cursor

- **Provider**: `OpenAI Compatible`
- **Base URL**: `http://localhost:8787/v1`
- **API Key**: `dummy`
- **Model ID**: `model-router-auto` (or `codestral-latest`, `llama-3.3-70b`, `gemini-3.7-flash`)

---

### 6. mini-agent

[mini-agent](https://github.com/Mitriyweb/mini-agent) is a lightweight coding agent harness that uses the OpenAI Chat Completions API:

```bash
git clone https://github.com/Mitriyweb/mini-agent.git
cd mini-agent
bun install
export OPENAI_BASE_URL="http://localhost:8787/v1"
export OPENAI_API_KEY="dummy"
bun run start -- -y "Check package.json and describe the project"
```

The default model is `model-router-auto`. Use `bun run start` without a task for interactive REPL mode.

---

## SSE Streaming (Server-Sent Events)

`model-router` supports real-time Server-Sent Events (SSE) streaming for both OpenAI and Anthropic formats.

### A. OpenAI SSE Stream (`/v1/chat/completions`)

Used by ZeroClaw, Aider, mini-agent, LangChain, and Web Chat UIs.

#### 1. CLI with `curl`:
```bash
curl -N -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model-router-auto",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Explain quicksort in 2 sentences."}
    ]
  }'
```
**Stream Chunk Format:**
```text
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Quicksort"},"finish_reason":null}]}
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" is a divide-and-conquer"},"finish_reason":null}]}
...
data: [DONE]
```

#### 2. JavaScript / TypeScript Frontend Example:
```javascript
const response = await fetch("http://localhost:8787/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "model-router-auto",
    stream: true,
    messages: [{ role: "user", content: "Hello!" }],
  }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") break;
    const chunk = JSON.parse(data);
    const content = chunk.choices?.[0]?.delta?.content;
    if (content) process.stdout.write(content);
  }
}
```

---

### B. Anthropic SSE Stream (`/v1/messages`)

Used by Claude Code and Anthropic clients.

```bash
curl -N -X POST http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "stream": true,
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```
**Stream Events Format:**
```text
event: message_start
data: {"type":"message_start","message":{"id":"...","role":"assistant","content":[],"usage":{"input_tokens":10}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}
```

---

## Development & Testing

```bash
# Run with hot reloading
bun run dev

# Run complete validation (strict typecheck + lint + tests + generated env check)
bun run validate

# Validate and also build a standalone binary
bun run verify

# Regenerate .env.example after changing src/providers/definitions.ts
bun run env:generate

# Run live E2E adapter tests against configured provider APIs (.env)
bun run test:e2e

### E2E Adapter Testing

`model-router` includes dedicated End-to-End (E2E) tests for each adapter (`cerebras`, `cloudflare`, `cohere`, `gemini`, `groq`, `huggingface`, `local`, `mistral`, `nvidia`, `openrouter`).

- **CI & Pre-commit Safety**: E2E tests do NOT run during CI (`bun test` or `bun run validate`) or pre-commit hooks to avoid consuming provider quotas or failing build pipelines without credentials.
- **Direct Live Verification**: Running `bun run test:e2e` sets `RUN_E2E=true` and directly issues requests via each adapter's `send()` and `sendStream()` methods to confirm API connectivity, authentication, and correct response translation.
- **Token Efficiency**: Each test sends a minimal payload (`maxTokens: 5`, single-word prompt) to verify availability while consuming minimal tokens.
- **Environment Gating**: An adapter test only executes if its required key (e.g., `GROQ_API_KEY`, `GEMINI_API_KEY`, `CLOUDFLARE_API_TOKEN`) is set and valid in `.env` (or environment variables). Set `LOCAL_E2E=true` to test local Ollama servers.

# Compile standalone executable
bun run build

# Compile all platform binaries
bun run build:all
```

---

## Build Process

The standalone executable bundles the version information directly from `package.json` during compilation, making it available at runtime without extra build scripts.

## License

[MIT](LICENSE)
