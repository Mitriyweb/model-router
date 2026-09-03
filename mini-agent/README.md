# mini-agent

A lightweight, modular coding agent harness compatible with **`model-router`** (or any OpenAI-compatible Chat Completions API).

Separated and adapted from [HowProgrammingWorks/Agent](https://github.com/HowProgrammingWorks/Agent).

---

## Features

- **Model Router Integration**: Pre-configured to connect to `http://localhost:8787/v1` with model `model-router-auto`.
- **Modular Local Tools**: Includes file & workspace operations (`read`, `write`, `edit`, `patch`, `delete`, `glob`, `grep`, `bash`, `check`, `fetch`, `todo`).
- **Interactive & CLI Modes**:
  - Run a single task from CLI arguments.
  - Or run in interactive CLI REPL mode for back-and-forth conversation.
- **Safety & Containment**: Workspace path containment checks prevent escaping the workspace directory. Interactive approval prompts before executing tools (or optional `-y` / `--auto-approve` flag).
- **Standalone Package**: Self-contained with its own `package.json`, dependencies, and tests so it can be extracted into an independent repository.

---

## Quick Start

### 1. Ensure `model-router` is running
```bash
# In the root model-router directory:
bun run start
```

### 2. Run `mini-agent`

#### Single CLI Task:
```bash
node start.js -y "Check package.json and describe the project"
```

Or via Bun:
```bash
bun run start -- -y "Check package.json and describe the project"
```

#### Interactive REPL Mode:
```bash
node start.js
```

#### Options & Flags:
```bash
node start.js [workspace-path] [options] [task...]

Options:
  -y, --auto-approve, --yes   Auto-approve tool execution without interactive prompt
  --dir <path>                Set the project workspace directory
  --model <model_id>          Override model ID (default: model-router-auto)
  --url <base_url>            Override API base URL (default: http://localhost:8787/v1)
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_BASE_URL` | `http://localhost:8787/v1` | OpenAI API endpoint |
| `MODEL` | `model-router-auto` | Model ID for completion |
| `OPENAI_API_KEY` | `dummy` | API Key for model-router / OpenAI |
| `AUTO_APPROVE` | `false` | Set to `true` to skip permission prompts |

---

## Available Tools

- `read`: Read file contents with offset and line limits.
- `write`: Create or overwrite a file inside the workspace.
- `edit`: Replace unique text fragments in a file.
- `patch`: Apply multiple hunk replacements to a file.
- `delete`: Delete a file inside the workspace.
- `glob`: Search files by wildcard/glob pattern.
- `grep`: Search file contents using regular expressions.
- `bash`: Run shell commands in the workspace root.
- `check`: Run `npm run check` or project check scripts.
- `fetch`: Fetch HTTP/HTTPS web documents.
- `todo`: Maintain structured task tracking lists.

---

## Tests

To run `mini-agent` unit tests:

```bash
npm test
# or
node --test tests/*.test.js
```

---

## Standalone Project Extraction

`mini-agent` is stored in its own folder (`mini-agent/`) with a dedicated `package.json`. You can move or copy the entire `mini-agent/` directory out of `model-router` into a separate repository at any time:

```bash
cp -r mini-agent /path/to/new-repo
cd /path/to/new-repo
npm install
npm start -- -y "Your task"
```
