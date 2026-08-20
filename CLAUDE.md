# model-router

Universal AI proxy that routes Claude Code, Agent Team, ZeroClaw, Aider, Cline, and any OpenAI-compatible client through **9 free-tier and local LLM providers** — automatically with fallback, caching, and rate limiting.

## Key Features

- **Dual API**: Anthropic (`/v1/messages`) + OpenAI (`/v1/chat/completions`, `/v1/models`) on the same port
- **9 providers**: Cerebras, Groq, Gemini, OpenRouter, Mistral, NVIDIA NIM, Cloudflare AI, Cohere, Local (Ollama)
- **Automatic fallback**: Tries providers in order, skips rate-limited or unconfigured ones
- **SHA-256 cache**: Exact-repeat requests served instantly without hitting upstream
- **SSE streaming**: Anthropic and OpenAI event formats, bidirectional converters
- **Rate limiter**: Per-provider RPM / TPM / RPD tracking

## Project Structure

```text
model-router/
├── src/
│   ├── adapters/              # Provider-specific adapters (one file per provider)
│   │   ├── openaiCompatible.ts  # Shared OpenAI-format logic + request/response converters
│   │   ├── gemini.ts            # Google Gemini (native API)
│   │   ├── cohere.ts            # Cohere Chat v2
│   │   ├── mistral.ts, cerebras.ts, groq.ts, nvidia.ts, cloudflare.ts, openrouter.ts, local.ts
│   ├── streaming/
│   │   ├── anthropicSSE.ts    # Writes Anthropic SSE events
│   │   ├── openaiSSE.ts       # Converts Anthropic SSE → OpenAI SSE chunks
│   │   └── reconstruct.ts     # Reconstructs full AnthropicResponse from stream
│   ├── resolvers/index.ts     # Maps TierName → adapter function
│   ├── config.ts              # Per-provider config, limits, env vars
│   ├── types.ts               # Shared types: NormalizedRequest, AnthropicResponse, TierName
│   ├── router.ts              # Core routing: tier ordering, fallback, cache, policy
│   ├── policies.ts            # Custom routing rules (exact-repeat cache, etc.)
│   ├── rateLimiter.ts         # RPM / TPM / RPD tracking per tier
│   ├── tokenizer.ts           # Token estimation
│   ├── cache.ts               # SHA-256 request cache
│   ├── server.ts              # HTTP server (Anthropic + OpenAI endpoints)
│   └── index.ts               # Entrypoint
├── tests/
│   ├── streaming.test.ts      # AnthropicSSEWriter + reconstructingStream
│   ├── openai.test.ts         # OpenAI request/response converters + SSE transformer
│   ├── cache.test.ts          # SHA-256 hash + store/retrieve
│   ├── router.test.ts         # Token estimation + tier planning
│   └── rateLimiter.test.ts    # RPM / TPM / RPD enforcement
├── docs/
│   └── index.html             # GitHub Pages landing page
├── .github/
│   ├── workflows/ci.yml       # CI: typecheck + lint + tests on push/PR
│   ├── workflows/release.yml  # Release: matrix builds (darwin-arm64/x64, linux-arm64/x64) + GitHub Release
│   └── workflows/deploy.yml   # Deploy docs/ to GitHub Pages
├── .agents/
│   └── workflows/review-and-commit.md  # /review-and-commit workflow
├── .env.example               # All env vars documented
├── install.sh                 # One-line installer script
├── biome.json                 # Linting and formatting config
├── tsconfig.json
└── package.json
```

## Development Workflow

1. Make code changes
2. Run `bun run validate` — typecheck + lint + tests must all pass
3. Use `/review-and-commit` to review and commit following conventional commits

## Key Commands

```bash
# Start dev server with hot reload
bun run dev

# Full validation (typecheck + biome + tests)
bun run validate

# Typecheck only
bun run typecheck

# Lint only (check)
bun run lint

# Lint with auto-fix
bun run lint:fix

# Run tests
bun test

# Build standalone binary
bun run build

# Build for all platforms (darwin-arm64/x64, linux-arm64/x64)
bun run build:all
```

## Connect Clients

### Claude Code & Agent Team (Anthropic API)
```bash
ANTHROPIC_BASE_URL=http://localhost:8787 ANTHROPIC_API_KEY=dummy claude
# Or for Agent Team:
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_API_KEY=dummy
agent-team run --all
```

### ZeroClaw / Aider / Cline / Cursor (OpenAI API)
```bash
export OPENAI_BASE_URL="http://localhost:8787/v1"
export OPENAI_API_KEY="dummy"
```

## API Endpoints

| Endpoint | Format | Used by |
|---|---|---|
| `POST /v1/messages` | Anthropic | Claude Code, Agent Team, Anthropic SDK |
| `POST /v1/chat/completions` | OpenAI | ZeroClaw, Aider, Cline, LangChain |
| `GET /v1/models` | OpenAI | Any OpenAI client |
| `GET /status` | JSON | Monitoring (RPM/TPM/RPD per provider) |
| `GET /health` | JSON | Health check |

## Environment Variables

Copy `.env.example` to `.env` and fill in keys for providers you want to use.

Key settings:
```bash
FALLBACK_ORDER=gemini,mistral,cerebras,groq,openrouter,nvidia,cloudflare,cohere,local
PORT=8787
```

## Project Links

- [GitHub Repository](https://github.com/Mitriyweb/model-router)
- [GitHub Pages](https://mitriyweb.github.io/model-router)
- [Releases](https://github.com/Mitriyweb/model-router/releases)

## Workflows

- `/review-and-commit` — review code and create a conventional commit
