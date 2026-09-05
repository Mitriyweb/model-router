---
description: Review code changes and create a commit following model-router repository standards
---

# Review & Commit Workflow

Review changed code for quality, correctness, and compliance with `model-router` standards, then commit if all checks pass.

## Phase 0: Detect Changes

```bash
git status
git diff --name-only
git diff --stat
```

1. Identify all changed files (`.ts`, `.sh`, `.json`, `.md`, `.yml`)
2. Read full content of each changed file
3. Categorize by type and verify specific rules:
   - **TypeScript (`.ts`)**: Type safety, strict null checks, no unhandled promises, proper error logging
   - **Shell scripts (`install.sh`, etc.)**: Shell correctness, POSIX compatibility, proper shebang (`#!/usr/bin/env bash`), `set -e`
   - **CI / GitHub Actions (`.github/workflows/`)**: Valid YAML structure, correct action versions
   - **Documentation & Configs (`.md`, `.json`)**: Proper formatting, up-to-date links and commands
   - **All files**: No hardcoded API keys, tokens, or personal secrets

## Phase 1: Code Review

For each changed file, check for violations and categorize:

- **Critical** — must fix before commit (broken syntax, security issues, exposed credentials, breaking API contract)
- **High** — should fix before commit (type errors, unhandled edge cases in streaming/routing, lint errors)
- **Medium** — nice to fix (code style, naming conventions, docstrings)

If critical or high issues are found -> fix them before proceeding.

### Run Validation Pipeline

```bash
bun run verify
```

This runs the full project validation chain in one command:
1. `tsc --noEmit` (TypeScript typecheck)
2. `biome check src/ tests/` (Biome linting & formatting)
3. `bun test` (Unit test suite across router, rateLimiter, cache, streaming)
4. `bun run build` (Single binary compilation check)

All checks must pass with exit code `0` before proceeding.

## Phase 2: Prepare Commit Message

**Format** (conventional commits):

```text
type: brief description

Optional body explaining rationale and key changes:
- Item 1
- Item 2
```

**Types:**
- `feat`: New feature or provider adapter support
- `fix`: Bug fix in routing, streaming, or adapter translation
- `refactor`: Code reorganization or cleanup without behavior changes
- `test`: Adding or updating test suites
- `docs`: Documentation updates (README, workflow files)
- `style`: Formatting or lint fixes
- `chore`: Dependency updates, tooling, or CI/CD adjustments
- `perf`: Performance or token-efficiency improvements

**Rules:**
- Subject line: lowercase `type:` prefix, max 72 characters
- No trailing period in the subject line
- Imperative mood ("add feature", not "added feature")

## Phase 3: Stage & Commit

```bash
git add <specific-files>
git status
git diff --cached
```

Verify:
- All intended source and test files are staged
- No generated or ignored files are included (`dist/`, `node_modules/`, `.router-state.json`, `.env`, `*.bun-build`)

### Create Commit

```bash
git commit -m "type: description"
```

**NEVER** use `--no-verify` or `-n` — the pre-commit hook (`bun run verify`) MUST run.

### Handle Hook / Check Failures

If validation or pre-commit hooks fail:

1. Read error output carefully
2. Apply fixes:
   - Biome formatting/linter: `bun run lint:fix` or `bun run format`
   - Type errors: resolve TypeScript compilation issues, then verify with `bun run typecheck`
   - Test failures: resolve regressions, then verify with `bun run test`
3. Stage fixed files: `git add <fixed-files>`
4. Create a **new** commit (never `--amend` unless explicitly requested by user)

### Verify Commit

```bash
git log --oneline -n 1
git diff HEAD~1 --stat
```

Confirm the commit message and changed files match intent.

## Phase 4: Version Release

If `package.json` contains a version bump, create and push a matching tag and GitHub Release after the commit is verified:

```bash
VERSION="<version from package.json>"
git tag -a "v${VERSION}" -m "release v${VERSION}"
git push origin "v${VERSION}"
gh release create "v${VERSION}" --title "v${VERSION}" --generate-notes
```

Verify that the tag points to the new commit and that the GitHub Release was created successfully. Do not create a tag or release when the package version is unchanged.

## Review Summary

After commit, output the standard summary:

```text
Commit: [hash] [message]
Files: [count] | LOC: [additions+deletions]
Checks: typecheck [pass/fail] | biome [pass/fail] | tests [pass/fail] | build [pass/fail]
Issues: [count critical] / [count high] / [count medium]
```

## Key Rules

1. **Never `--no-verify`** — pre-commit hook must always run.
2. **All checks pass** before commit (`bun run verify`).
3. **Use `bun run`** — never `npm` / `yarn` / `pnpm`.
4. **Conventional commits** — `type: description` format.
5. **New commits only** — never amend unless explicitly requested.
6. **Version bumps require a matching `v<version>` tag and GitHub Release** after the commit is verified.
