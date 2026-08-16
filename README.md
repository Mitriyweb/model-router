# model-router

Anthropic-compatible proxy that lets Claude Code run on **10 free-tier and local LLM providers** instead of the paid Claude API.

## Supported Providers

| Provider | Free Tier Limit | API Type | Best For |
|---|---|---|---|
| **GitHub Models** | 15 RPM / 150 RPD | Azure OpenAI | GPT-4o, Claude 3.5 Sonnet, Llama 3.3 70B |
| **Cerebras** | 1M+ tokens / day | OpenAI-compatible | Ultra-fast Llama-3.3-70b batch processing |
| **Groq** | 30 RPM / 6k TPM / 14.4k RPD | OpenAI-compatible | Instant streaming and fast tool calling |
| **Google Gemini** | 15 RPM / 1M TPM / 1.5k RPD | Gemini API | Large context windows (>4k tokens) |
| **OpenRouter** | 20 RPM / 50 RPD (free models) | OpenAI-compatible | Broad selection of open models |
| **Mistral AI** | 2 RPM / 500k TPM / ~1B tpm/mo | OpenAI-compatible | Codestral & Mistral Large |
| **NVIDIA NIM** | 40 RPM / 1,000 requests | OpenAI-compatible | 90+ models (Llama, DeepSeek, Phi) |
| **Cloudflare AI** | 60 RPM / 10k RPD | Cloudflare AI | Serverless edge inference |
| **Cohere** | 10 RPM / 100 RPD | Cohere Chat v2 | Command R+ with advanced RAG & tool-use |
| **Local (Ollama)** | Unlimited | OpenAI-compatible | Fully offline & private execution |

---

## Quick Install

Install `model-router` binary with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/Mitriyweb/model-router/main/install.sh | bash
```

Or install via Bun:

```bash
git clone https://github.com/Mitriyweb/model-router.git
cd model-router
bun install
bun run build
```

---

## How it works

Claude Code sends requests in Anthropic's `/v1/messages` format. This server exposes that same endpoint, but internally:

1. **Estimates request size** (input tokens) via `gpt-tokenizer` (`cl100k_base`).
2. **Plans tier order** (`src/router.ts: planTierOrder`):
   - Big context (>4k tokens) → Gemini Flash first (huge 1M TPM budget).
   - Otherwise → walks configured `FALLBACK_ORDER`.
3. **Applies policies & checks health**:
   - `exact-repeat-from-cache` checks SHA-256 request cache to return instant 0-token responses.
   - For each tier: checks API key / token, context fit, and in-memory rate limiter quotas.
   - On error or rate limit, automatically falls through to the next tier.
4. **Translates streaming & non-streaming responses** back to Anthropic SSE format with full tool calling (`tool_use` / `tool_result`) support.

---

## Usage

### 1. Configure Environment

Copy `.env.example` to `.env` and fill in any keys you have:

```bash
cp .env.example .env
```

### 2. Start the Proxy

```bash
# Using installed binary:
model-router

# Or using Bun:
bun run start
```

### 3. Connect Claude Code

Run Claude Code pointing to your local proxy:

```bash
ANTHROPIC_BASE_URL=http://localhost:8787 ANTHROPIC_API_KEY=dummy claude
```

> **Tip:** You can set a permanent alias in your `~/.zshrc` (or `~/.bashrc`):
> ```bash
> echo 'alias claude-free="ANTHROPIC_BASE_URL=http://localhost:8787 ANTHROPIC_API_KEY=dummy claude"' >> ~/.zshrc
> source ~/.zshrc
> ```
> And simply launch it with `claude-free`.

Check tier usage & rate limits anytime:

```bash
curl http://localhost:8787/status
```

---

## Development

```bash
# Run with hot reloading
bun run dev

# Run full validation (typecheck + lint + tests)
bun run validate

# Compile standalone binary
bun run build

# Compile all platform binaries (darwin-arm64, darwin-x64, linux-x64, linux-arm64)
bun run build:all
```

---

## License

[MIT](LICENSE)
