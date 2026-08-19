# model-router

Universal AI proxy that allows **Claude Code**, **ZeroClaw**, **Aider**, **Cline (Roo Code)**, **Cursor**, and custom Chat UIs to run on **9 free-tier and local LLM providers** instead of expensive paid APIs.

## Supported Providers

| Provider | Free Tier Limit | API Type | Best For |
|---|---|---|---|
| **Cerebras** | Trial: 1M+ tokens / day | OpenAI-compatible | Ultra-fast Llama-3.3-70b batch processing |
| **Groq** | 30 RPM / 6k TPM / 14.4k RPD | OpenAI-compatible | Instant streaming and fast tool calling |
| **Google Gemini** | 15 RPM / 1M TPM / 1.5k RPD | Gemini API | Large context windows (>4k tokens) |
| **OpenRouter** | 20 RPM / 50 RPD (free models) | OpenAI-compatible | Broad selection of open models |
| **Mistral AI** | 2 RPM / 500k TPM / ~1B tpm/mo | OpenAI-compatible | Codestral & Mistral Large |
| **NVIDIA NIM** | 40 RPM / 1,000 requests | OpenAI-compatible | 90+ models (Llama, DeepSeek, Phi) |
| **Cloudflare AI** | 60 RPM / 10k RPD | Cloudflare AI | Serverless edge inference |
| **Cohere** | 10 RPM / 100 RPD | Cohere Chat v2 | Command R+ with advanced RAG & tool-use |
| **Local (Ollama)** | Unlimited | OpenAI-compatible | Fully offline & private execution |

---

## Dual API Architecture

`model-router` simultaneously exposes two standard APIs on port `8787`:

1. **Anthropic API** (`POST /v1/messages`): For Claude Code and Anthropic clients.
2. **OpenAI API** (`POST /v1/chat/completions` & `GET /v1/models`): For ZeroClaw, Aider, Cline, Roo Code, Cursor, Continue.dev, and Web Chat interfaces.

---

[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Visit-blue)](https://mitriyweb.github.io/model-router)

## Quick Install

Install `model-router` binary with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/Mitriyweb/model-router/main/install.sh | bash
```

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

### 2. ZeroClaw & Claw Analogs

ZeroClaw connects directly via the OpenAI Chat Completions endpoint:

```bash
export OPENAI_BASE_URL="http://localhost:8787/v1"
export OPENAI_API_KEY="dummy"
zeroclaw --model model-router-auto
```

---

### 3. Aider

```bash
export OPENAI_API_BASE="http://localhost:8787/v1"
export OPENAI_API_KEY="dummy"
aider --model openai/model-router-auto
```

---

### 4. Cline / Roo Code / Continue.dev / Cursor

- **Provider**: `OpenAI Compatible`
- **Base URL**: `http://localhost:8787/v1`
- **API Key**: `dummy`
- **Model ID**: `model-router-auto` (or `codestral-latest`, `llama-3.3-70b`, `gemini-3.7-flash`)

---

## SSE Streaming (Server-Sent Events)

`model-router` supports real-time Server-Sent Events (SSE) streaming for both OpenAI and Anthropic formats.

### A. OpenAI SSE Stream (`/v1/chat/completions`)

Used by ZeroClaw, Aider, LangChain, and Web Chat UIs.

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

# Run complete validation (typecheck + lint + tests)
bun run validate

# Compile standalone executable
bun run build

# Compile all platform binaries
bun run build:all
```

---

## License

[MIT](LICENSE)
