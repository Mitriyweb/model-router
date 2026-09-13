# OpenSpec: Add OpenCode Zen Provider with Ling 3.0 Flash Fin Free

## OpenSpec Change ID: `add-opencode-ling-provider`

### 1. Overview
Add OpenCode Zen as a new LLM provider tier (`opencode`) in `model-router` supporting the `ling-3.0-flash-fin-free` model via OpenAI-compatible Chat Completions API.

### 2. Provider Specification
- **Provider Tier Name:** `opencode`
- **Default Model:** `ling-3.0-flash-fin-free`
- **API Standard:** OpenAI-compatible Chat Completions (`/chat/completions`)
- **Base URL Default:** `https://opencode.ai/zen/v1`
- **Endpoint:** `POST https://opencode.ai/zen/v1/chat/completions`
- **Authentication:** `Authorization: Bearer <OPENCODE_API_KEY>` (in headers only, never in URL or logs)
- **Context Window:** `262,144` tokens
- **Max Output Tokens:** `32,768` tokens (`max_tokens`)
- **Reasoning:** Supported natively (`reasoning` / `reasoning_content` deltas and content)
- **Streaming Usage:** Supported (`usage` in stream chunks)
- **Pricing:** `$0` input / `$0` output / `$0` cache read / `$0` cache write (Router local rate limits apply)

### 3. Architecture & Components
1. **Types (`src/types.ts`):**
   - Add `"opencode"` to `TierName` string union.
2. **Configuration (`src/config.ts`):**
   - Add `opencode` config object with `apiKey`, `baseUrl`, `model`, and `limits` (rpm, tpm, rpd).
   - Read from environment variables: `OPENCODE_API_KEY`, `OPENCODE_BASE_URL`, `OPENCODE_MODEL`, `OPENCODE_RPM`, `OPENCODE_TPM`, `OPENCODE_RPD`.
3. **Adapter (`src/adapters/opencode.ts`):**
   - Implement `opencodeAdapter: ProviderAdapter`.
   - Implement `canHandle(req, estimatedTokens)` respecting 262,144 token context capability and router context limits.
   - Implement `send(req, opts)` using `buildOpenAIPayload`, clamping requested `max_tokens` to 32,768 max output if specified, fetching `${config.opencode.baseUrl}/chat/completions`, and returning `openAIResponseToAnthropic(data, model)`.
   - Implement `sendStream(req, opts)` using `createOpenAICompatibleStream`.
4. **OpenAI Compatibility Helpers (`src/adapters/openaiCompatible.ts`):**
   - Enhance `openAIResponseToAnthropic` to support both `reasoning` and `reasoning_content` fields.
   - Enhance `streamOpenAIToAnthropic` to support `reasoning` and `reasoning_content` deltas as well as `input_tokens`/`output_tokens` in streaming usage.
5. **Router (`src/router.ts`):**
   - Import `opencodeAdapter` and register in `adapters` map and `limitsByTier`.
   - Update `hasCredentials(tier)` to check `Boolean(config.opencode.apiKey)`.
6. **Server (`src/server.ts`):**
   - Add `"opencode"` to `VALID_TIERS`.
7. **Environment & Documentation (`.env.example`, `README.md`, `docs/index.html`):**
   - Document OpenCode Zen environment variables and tier capabilities.

### 4. Acceptance Criteria
- [x] Change specification defined in `openspec/changes/add-opencode-ling-provider/spec.md`.
- [ ] `opencode` exists as a valid `TierName` in `src/types.ts`.
- [ ] `opencodeAdapter` exists in `src/adapters/opencode.ts`.
- [ ] Default model is `ling-3.0-flash-fin-free`.
- [ ] Default base URL is `https://opencode.ai/zen/v1`.
- [ ] `OPENCODE_API_KEY` environment variable is supported for credentials.
- [ ] Non-streaming requests work and convert OpenAI response to Anthropic response.
- [ ] Streaming requests work via SSE converter.
- [ ] Reasoning and reasoning deltas (`reasoning`, `reasoning_content`) are preserved.
- [ ] Usage in streaming is handled.
- [ ] Tool calling remains compatible with OpenAI schema.
- [ ] 262,144 context capability is respected in `canHandle`.
- [ ] 32,768 max output capability is respected (clamping `max_tokens` when specified above 32,768).
- [ ] `max_tokens` field is sent when requested.
- [ ] Force routing (`forceTier: "opencode"` or header `x-router-provider: opencode`) works.
- [ ] Credentials detection (`hasCredentials("opencode")`) works.
- [ ] Fallback integration works across router.
- [ ] Error handling formats `ProviderError` properly.
- [ ] Tests pass (`bun test`).
- [ ] Typecheck passes (`bun run typecheck`).
- [ ] Lint passes (`bun run lint`).
- [ ] Build passes (`bun run build`).
- [ ] `.env.example` is updated.
- [ ] README/documentation is updated.
