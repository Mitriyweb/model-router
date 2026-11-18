# Refactoring Plan: `model-router`

Status: proposed
Scope: whole-project structural refactor + targeted correctness/robustness fixes
Baseline: `bun run validate` must stay green after every phase

---

## 1. Assessment

The project works and has good bones: a single normalized request contract
(`NormalizedRequest` in, `AnthropicResponse` out), a clear adapter boundary, and a
coherent SSE model for both Anthropic and OpenAI clients.

The structural debt is concentrated in two places:

1. Provider knowledge is repeated in five or more files.
2. The send and streaming routing pipelines are near-copies of each other.

There are also several concrete correctness bugs (cache collisions, unchecked
`FALLBACK_ORDER`, rate-limiter load race) and hardening gaps (unbounded cache,
no auth, secret in URL, payload logging).

Current size: ~6.3k lines across 24 source files and 20 test files.

---

## 2. Findings

### A. Provider knowledge is scattered (highest-leverage problem)

Adding or changing a provider currently requires touching at least six places:

| Concern | Where it lives today |
|---|---|
| Env parsing + defaults + limits | `src/config.ts:104-213` (10 hand-written blocks) |
| Provider names | `src/types.ts:62-72` (`TierName` union) |
| Adapter map | `src/router.ts:23-34` |
| Limits map | `src/router.ts:36-47` |
| Credential check | `src/router.ts:218-241` (10-case switch) |
| Valid tier list | `src/server.ts:87-98` (third copy) |
| Models/providers endpoints | `src/server.ts:186-271` |
| Docs/defaults | `.env.example`, `README.md`, `src/index.ts:52-58` |

Drift already exists:

- `src/config.ts:123` defaults Gemini to `gemini-3.7-flash`; `.env.example:24` says `gemini-3.5-flash`.
- `src/index.ts:57` CLI help still lists only four providers.
- `package.json` description/keywords still describe four providers.

### B. Adapter boilerplate duplication

Eight adapters (`cerebras`, `groq`, `mistral`, `nvidia`, `openrouter`, `cloudflare`,
`huggingface`, `local`) are ~450 lines of the same 50-line pattern:

```
pick model -> buildOpenAIPayload -> fetch -> readProviderError -> openAIResponseToAnthropic
stream: createOpenAICompatibleStream
```

They differ only in URL, auth headers, tier id, and max context.

Duplicated verbatim:

- `sanitizeGeminiSchema` (`src/adapters/gemini.ts:21-88`) and
  `sanitizeOpenAICompatibleSchema` (`src/adapters/openaiCompatible.ts:98-164`) are the
  same ~67-line function.
- `buildCoherePayload` (`src/adapters/cohere.ts:7-55`) is approximately
  `buildOpenAIPayload` (`openaiCompatible.ts:294-342`).
- `cohereResponseToAnthropic` is approximately `openAIResponseToAnthropic`.
- SSE frame parsing exists five times:
  - `openaiCompatible.ts:456-519`
  - `gemini.ts:239-294`
  - `cohere.ts:168-230`
  - `openaiSSE.ts:123-147`
  - `reconstruct.ts:101-125`

### C. Router pipeline duplication

`routeRequest` (`src/router.ts:106-216`) and `routeRequestStream`
(`src/router.ts:249-332`) duplicate:

- policy matching
- tier ordering
- credential checks
- context pruning
- TPM budget checks
- `canHandle` checks
- rate-limit checks

They have already diverged:

- Streaming records `effectiveBudgetTokens` as if it were actual usage.
- Streaming silently `continue`s without recording a skip reason, so diagnostics differ
  from non-streaming.

### D. Correctness and robustness gaps

1. **Cache collisions** — `cacheKey` (`src/cache.ts:5-16`) omits `req.model`,
   `maxTokens`, and `stream`. The same prompt sent to `groq/...` then `gemini/...`
   returns the first provider's cached answer. Different `max_tokens` share an entry.
2. **Unbounded cache** — module-level `Map` with no TTL or size cap
   (`src/cache.ts:3`); leaks memory in long-running processes.
3. **Invalid `FALLBACK_ORDER` crashes** — `parseFallbackOrder` casts arbitrary strings to
   `TierName` (`src/config.ts:86-96`); an unknown name yields
   `adapters[tier] === undefined` at `src/router.ts:146`.
4. **Rate-limiter load race** — the constructor starts async disk load
   (`src/rateLimiter.ts:22-24`), but `ready()` (`:142`) is never awaited anywhere.
   Early requests can miss persisted state. No shutdown flush, so the last debounced
   500ms of usage is lost on exit.
5. **Hugging Face inconsistencies** — `send` ignores `opts.signal`
   (`src/adapters/huggingface.ts:34`); `sendStream` omits the tier id (`:87`), so
   `429`s never mark HF unavailable. Related: no-op ternary in
   `src/adapters/openaiCompatible.ts:412-414`.
6. **Secret in URL** — Gemini API key is a query parameter
   (`src/adapters/gemini.ts:205,311`), which lands in proxy logs and traces.
   Modern form is the `x-goog-api-key` header.
7. **No auth, default network exposure** — `Bun.serve` has no `hostname` override
   (`src/server.ts:288`), and `/reset` (`:353-361`) is unauthenticated.
8. **Unstructured logging with payload leakage** — `src/adapters/groq.ts:40` logs up to
   1.2 KB of every upstream response at default level. HF logs per-request model and
   provider. No levels, request IDs, or redaction.
9. **Type looseness** — `ContentBlock.tool_result.content` is `string | unknown`, which
   collapses to `unknown` (`src/types.ts:13`). Both `thought_signature` and
   `thoughtSignature` are carried everywhere. HTTP bodies are `any`.
10. **Pruner performance** — `estimateRequestTokens` re-tokenizes the whole request on
    every loop iteration and inside `truncateText`'s binary search
    (`src/pruner.ts:204-274`), producing O(n^2) tokenizer work on large contexts.
11. **Inconsistent context limits** — some adapters use `config.routerMaxContextTokens`,
    others the hard-coded 128k. Gemini always returns `true` (`src/adapters/gemini.ts:198`).
    Cohere uses the global value.
12. **Two token estimators** — `src/router.ts:50-57` and `src/pruner.ts:21-32` compute
    slightly different numbers from the same request.

### E. Tests and tooling

- Eight adapter test files are the same ~82-line test copy-pasted
  (`tests/adapters/*.test.ts`); only config keys change.
- Pipeline decisions (fallback ordering, skip reasons, budget math, policy interaction,
  cache keys) have thin coverage.
- `any` is allowed globally (`biome.json:26`).
- `tsconfig` lacks `noUncheckedIndexedAccess`, which would have caught the
  `FALLBACK_ORDER` bug.
- `package.json` `bin` points at `src/index.ts` without a shebang, so an npm-installed
  bin would not execute.

---

## 3. Target shape

Keep the current contract boundary. Collapse provider metadata into one declarative
registry, and make the router one pipeline with two sinks.

```text
src/
├── index.ts                  # CLI + lifecycle (start, shutdown)
├── server/
│   ├── index.ts              # Bun.serve, route table, shutdown hooks
│   ├── http.ts               # json(), readBody (gzip/deflate/br), errors, auth
│   └── handlers.ts           # messages / chat / models / providers / status
├── providers/
│   ├── definitions.ts        # SINGLE source of truth
│   ├── index.ts              # built config -> adapters, credential checks
│   ├── openai.ts             # createOpenAIAdapter(definition)
│   ├── gemini.ts             # protocol-specific payload/response/stream
│   ├── cohere.ts
│   └── schema.ts             # one JSON-Schema sanitizer
├── routing/
│   ├── router.ts             # execute / executeStream over AttemptPlan[]
│   ├── planner.ts            # pure: policy + order + options -> AttemptPlan[]
│   ├── attempt.ts            # pure: prune, budget, canHandle, rate limit -> skip/reason
│   └── policies.ts
├── streaming/
│   ├── sse.ts                # one parser + one frame encoder
│   ├── anthropicWriter.ts
│   ├── openaiWriter.ts
│   └── reconstruct.ts
├── limits/rateLimiter.ts
├── cache/index.ts            # LRU + TTL, model-aware key
├── text/{tokenizer,pruner}.ts
├── config/index.ts           # validated env -> typed Config
├── log.ts                    # leveled logger, redaction
└── types.ts
```

### Provider registry sketch

This single file replaces ~350 lines spread across `config.ts`, `router.ts`,
`server.ts`, and `types.ts`.

```ts
export const PROVIDERS = {
  groq: {
    label: "Groq",
    protocol: "openai",
    credentials: ["GROQ_API_KEY"],
    baseUrl: { env: "GROQ_BASE_URL", default: "https://api.groq.com/openai/v1" },
    model:   { env: "GROQ_MODEL",   default: "llama-3.3-70b-versatile" },
    limits:  { rpm: 30, tpm: 6_000, rpd: 14_400 },
    headers: (cfg) => ({ Authorization: `Bearer ${cfg.apiKey}` }),
    contextLimit: 128_000,
  },
  // ...
} as const satisfies Record<string, ProviderDefinition>;

export type TierName = keyof typeof PROVIDERS; // no more manual union
```

Everything derives from it:

- `config`
- adapters
- `VALID_TIERS`
- `hasCredentials`
- `/v1/models`
- `/v1/providers`
- generated `.env.example` sections

---

## 4. Phased execution

Each phase is a standalone green PR (`bun run validate`). Behavior fixes are separated so
they can be reviewed and reverted independently.

### Phase 0 — Guardrails (before touching structure)

- Add characterization tests for:
  - cache hit/miss semantics
  - fallback order
  - skip reasons
  - `/v1/models` and `/v1/providers` response shapes
  - provider-prefixed model parsing
- Add a shared test helper to snapshot/restore mutable `config` and `rateLimiter` state
  (today this boilerplate is repeated in every test).
- Run `bun run validate` and record the current pass count.

Exit criteria: new tests pass on unmodified code.

### Phase 1 — De-duplicate low-risk primitives (no behavior change)

- `src/streaming/sse.ts`: one async frame iterator plus one encoder; migrate all five
  parsers.
- `src/providers/schema.ts`: single schema sanitizer; delete the Gemini copy.
- One token estimator used by both router and pruner.
- Typed errors: keep `ProviderError`; add `AllTiersFailedError { attempts }` and
  `ConfigError`.
- `src/log.ts` with `LOG_LEVEL` and request IDs; delete raw-payload logging.

Exit criteria: identical tests; net ~300 lines removed.

### Phase 2 — Provider registry + adapter factories

- Add `providers/definitions.ts` and `providers/openai.ts`
  (`createOpenAIAdapter`); keep `gemini` and `cohere` as protocol modules.
- Make `config` a generic loader (`PROVIDER_PREFIX_API_KEY`, `_BASE_URL`, `_MODEL`,
  `_RPM`, `_TPM`, `_RPD`) with Cloudflare's two-key and HF's provider exception expressed
  declaratively.
- Delete the eight per-provider adapter files; keep thin re-export shims only while tests
  migrate.
- Derive `TierName`, `VALID_TIERS`, credential checks, and the models/providers endpoints
  from the registry.

Exit criteria: adding a provider is one registry entry; every endpoint test unchanged.

### Phase 3 — Router pipeline

- `routing/planner.ts`: `planAttempts(req, opts)` returns `AttemptPlan[]` with `policy`,
  ordered tiers, and force options. Pure and testable.
- `routing/attempt.ts`: `prepareAttempt(tier, req, estimated, limits)` returns
  `{ request, tokens, budget }` or `{ skip: reason }`.
- `routing/router.ts`: one loop for both modes, parameterized by sink (`send` vs
  `sendStream`), with identical `attempts` diagnostics.
- Record actual stream usage after `message_stop` when available, instead of pre-counting.

Exit criteria: send/stream skip behavior converges; per-tier diagnostics in one place.

### Phase 4 — Config hardening and security defaults

- Fail fast with a readable list of invalid env values.
- Validate `FALLBACK_ORDER` against the registry.
- Clamp numeric limits.
- Add `ROUTER_HOST` (default `127.0.0.1`) and optional `ROUTER_AUTH_TOKEN`; protect
  `/reset`.
- Move the Gemini key to `x-goog-api-key`.
- Fix default-model drift; generate `.env.example` sections from the registry with a CI
  drift check.

Exit criteria: a typo in `.env` produces a clear startup error instead of a runtime crash.

### Phase 5 — Cache and rate-limiter correctness

- `ResponseCache`:
  - TTL (default ~10 minutes)
  - max entries (default ~500)
  - LRU eviction
  - key includes `model`, `maxTokens`, `temperature`, `tools`
  - expose stats in `/status`
  - env-configurable limits
- `RateLimiter`:
  - await `ready()` before listening
  - atomic temp-file write + rename
  - flush on `SIGINT`/`SIGTERM`
  - aggregate/cap persisted arrays
  - remove dead `removeExpiredCooldown`

Exit criteria: no cache cross-model collisions; state survives restart; tests cover
TTL/LRU and the load race.

### Phase 6 — Server split

- Route table instead of the if-chain.
- Explicit `405` handling.
- Body size cap (`maxRequestBodySize`).
- Support `gzip`, `deflate`, and `br`.
- Central error mapper: `400` invalid JSON/validation, `413` too large, `401` auth,
  `502` all tiers failed, with OpenAI vs Anthropic envelopes in one place.
- Optional CORS; consistent `x-router-tier` and request ID headers.

Exit criteria: handlers are thin; error shapes are consistent and tested.

### Phase 7 — Tests, tooling, docs

- One parameterized OpenAI-compatible adapter suite (8 providers x cases).
- Protocol suites for Gemini and Cohere.
- Router tests for ordering, forced tiers, policy bypass, budget pruning, fallback, and
  cache interaction.
- Enable `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`.
- Tighten `any` at HTTP boundaries with `unknown` + parsers (no new dependency needed).
- Update README, package description/keywords, and CLI help.
- Fix `bin`/shebang, or drop the npm `bin` field.

Exit criteria: `bun run validate` green, materially higher coverage on routing/cache/limits,
docs match runtime.

---

## 5. Optional behavior changes requiring explicit approval

These are intentionally not hidden inside refactor PRs.

1. **Cache policy scope** — should cache apply to streaming and to requests with tools?
   Today it applies to both by default.
2. **Cache TTL and size defaults** — recommend 10 minutes / 500 entries; alternatives are
   in-memory-only with a hard cap.
3. **Default bind address** — changing `0.0.0.0` to `127.0.0.1` is safer but breaks LAN
   use. Make it env-configurable.
4. **`max_tokens` in cache key** — correct, but lowers hit rate. Decide whether
   correctness outweighs repeat savings.
5. **Streaming usage accounting** — record actual usage after completion rather than an
   estimate. Improves limiter accuracy but requires waiting.

---

## 6. Risks and non-goals

**Non-goals**

- Changing fallback heuristics.
- Changing endpoint paths.
- Renaming env vars.
- Changing provider protocol semantics.
- Changing public response shapes.

Keep `/v1/messages`, `/v1/chat/completions`, `/v1/models`, `/v1/providers`, `/status`, and
`/health` stable.

**Risks**

- Phases touching config and `TierName` ripple through tests. Mitigate by keeping source
  files as re-export shims in Phases 2-3 and migrating imports gradually.
- Tests mutate the singleton `config` and `rateLimiter`. Phase 0's helper should make this
  explicit before code moves.
- PR discipline: one phase per PR; behavior fixes in separate commits with their own
  tests; no formatting churn mixed in.

---

## 7. Success metrics

- Provider addition: 1 registry entry (was ~6 files).
- Adapter code: ~450 lines -> ~120 (factory + two protocol modules).
- SSE parsers: 5 -> 1.
- Router send/stream pipeline: 2 copies -> 1.
- Zero manual tier lists outside `providers/definitions.ts`.
- `bun run validate` green after every phase.
- Cache and rate-limiter regressions covered by tests.
- No secrets or response bodies in default logs.

---

## 8. Open decisions

1. **Scope:** behavior-preserving refactor only, or include the correctness/security fixes
   (cache key, config validation, auth, Gemini key) as separate PRs in the same effort?
2. **Aggressiveness:** incremental in place with re-export shims (recommended), or a clean
   folder restructure in one go?
3. **Dependencies:** stay dependency-free (hand-rolled env validation), or allow a small
   validation library such as Zod?
