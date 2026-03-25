<div align="center">

# Claudex

**Bridge Claude Code to ChatGPT Codex and use your ChatGPT subscription as the backend for Claude Code.**

[![npm version](https://img.shields.io/npm/v/@caixiaoshun/claudex.svg)](https://www.npmjs.com/package/@caixiaoshun/claudex)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

</div>

---

## What Is This?

**Claudex** is a local proxy that lets you point [Claude Code](https://docs.anthropic.com/en/docs/claude-code) at the ChatGPT Codex backend instead of Anthropic's API.

It accepts Claude Code's Anthropic-style requests, converts them into the Codex Responses API format, forwards them to `chatgpt.com/backend-api/codex/responses`, and converts the responses back into Anthropic-compatible output.

This is useful if:

- you already have ChatGPT Plus/Pro with Codex access
- you want Claude Code's CLI / IDE workflow
- you do not want to pay separately for Anthropic API usage just to use Claude Code

---

## Installation

```bash
npm install -g @caixiaoshun/claudex
```

Or build from source:

```bash
git clone https://github.com/caixiaoshun/claudex.git
cd claudex
npm install
npm run build
```

---

## Recent Updates

- Claude Code compatibility now covers modern client behavior such as `system -> developer`, `web_search_20250305`, `disable_parallel_tool_use`, `thinking` / `thinking_delta`, streamed `function_call_arguments`, and structured `tool_result` payloads with images.
- `POST /v1/messages/count_tokens` is implemented so Claude Code can request token estimates without calling Anthropic.
- `claude --resume` and `claude --continue` are bridged locally by reconstructing prior turns from `~/.claude/projects` when the Codex backend cannot continue natively.
- Session recovery first checks shell history, then falls back to the active `claude` process command line if shell history has not been written yet.
- Live Windows E2E validation now covers print/json/stream mode, `CLAUDE.md`, skills, slash commands, plugins, MCP, hooks, subagents, Todo/file workflows, and real `resume` / `continue` flows with Claude Code `2.1.76`.

For the detailed audit, see [`CLAUDE_CODE_COMPATIBILITY.md`](CLAUDE_CODE_COMPATIBILITY.md).

---

## Quick Start

### 1. Bypass Claude Code onboarding once

Claude Code requires onboarding to be marked complete. Run this once:

```bash
node --eval "
const fs = require('fs');
const path = require('path');
const file = path.join(require('os').homedir(), '.claude.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
config.hasCompletedOnboarding = true;
fs.writeFileSync(file, JSON.stringify(config, null, 2));
console.log('Onboarding bypassed');
"
```

### 2. Start Claudex

```bash
claudex
```

On first run, Claudex opens the browser for ChatGPT OAuth login and then starts the proxy on port `4000` by default.

### 3. Point Claude Code at the local proxy

macOS / Linux:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_API_KEY=sk-ant-placeholder
```

Windows PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:4000"
$env:ANTHROPIC_API_KEY = "sk-ant-placeholder"
```

Windows CMD:

```cmd
set ANTHROPIC_BASE_URL=http://localhost:4000
set ANTHROPIC_API_KEY=sk-ant-placeholder
```

### 4. Use Claude Code normally

```bash
claude "Help me refactor this function"
```

All Claude Code traffic now flows through Claudex to the ChatGPT Codex backend.

---

## Claude Code Compatibility

Claudex is no longer just a thin `/v1/messages` translator. It now specifically adapts Claude Code behaviors that matter in real usage, including:

- `system` prompt conversion into a Codex `developer` message
- Claude-style tool schemas emitted as Codex function tools with `strict: false`
- long MCP tool name shortening and response-side restoration
- built-in Claude tool mapping such as `web_search_20250305`
- `disable_parallel_tool_use` to `parallel_tool_calls`
- `thinking` blocks and streamed `thinking_delta`
- streamed `function_call_arguments.delta` / `function_call_arguments.done`
- structured `tool_result` content with both text and images
- local `/v1/messages/count_tokens` estimation
- local `claude --resume` / `claude --continue` session reconstruction

Live validation was run against an installed Claude Code CLI on Windows. The proxy-relevant paths now cover:

- `claude -p` text, `json`, and `stream-json`
- `CLAUDE.md` and project memory loading
- slash commands and skills
- plugin-backed commands and custom agents
- MCP tools, resources, and prompts
- hooks
- subagent delegation
- Todo / file workflows
- `resume` / `continue`

See [`CLAUDE_CODE_COMPATIBILITY.md`](CLAUDE_CODE_COMPATIBILITY.md) for the feature-by-feature matrix.

---

## Credential Reuse

If you already have Codex CLI or opencode installed and logged in, you can skip the browser OAuth flow:

```bash
claudex --reuse-codex
```

Claudex looks for credentials in:

| Source | Path |
|--------|------|
| OpenAI Codex CLI | `~/.codex/auth.json` |
| opencode | `~/.opencode/session.json` |
| opencode v2 | `~/.opencode/auth/codex.json` |

To see which sources are available:

```bash
claudex --list-sources
```

---

## Windows E2E Verification

To validate a checkout against a real Claude Code session on Windows:

1. Build the project.

```powershell
npm install
npm run build
```

2. Start the proxy with debug logging.

```powershell
claudex --reuse-codex --debug
```

3. In another PowerShell window, point Claude Code at the proxy.

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:4000"
$env:ANTHROPIC_API_KEY = "sk-ant-placeholder"
```

If Claude Code's local `WebFetch` tool fails with `unable to get local issuer certificate`, that is usually a local Node.js trust-store problem rather than a Claudex issue. For quick validation only:

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
```

Prefer installing the correct root certificate for a permanent fix.

4. Exercise real Claude Code flows, for example:

- `Run "pwd" and tell me the result.`
- `Fetch https://example.com and summarize it.`
- `Delegate a small subtask to another agent and return its summary.`
- `Create and maintain a todo list while doing a multi-step task.`
- `Read a scratch file, make a small edit, and show the result.`
- `Resume the previous session and recall what I asked you to store.`

Successful validation means the session completes in Claude Code, tool output renders normally, and the proxy log stays free of upstream `Codex API error: 400` failures.

---

## Model Selection And Reasoning

### Automatic tier mapping

Claudex maps Anthropic model names to the best available Codex model from the live model list. If live discovery is unavailable, it falls back to built-in defaults.

| Claude Code sends | Claudex uses |
|-------------------|--------------|
| `claude-opus-*` | High-tier live mapping, fallback `gpt-5.4` |
| `claude-*-sonnet-*` | Mid-tier live mapping, fallback `gpt-5.4-mini` |
| `claude-*-haiku-*` | Fast-tier live mapping, fallback `gpt-5.4-nano` |

Startup logs print the actual resolved mapping, including an explicit `sonnet4.6 -> ...` example line.

### Override at startup

```bash
claudex --model gpt-5.4-mini --reasoning high
```

### Override via environment variables

```bash
CODEX_MODEL=gpt-5.4-mini CODEX_REASONING=high claudex
```

### Override at runtime

```bash
curl -X POST http://localhost:4000/claudex/config \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.4-mini", "reasoning": "high"}'
```

### Override from Claude Code `/model`

Claudex also supports the convention:

```text
/model claudex:gpt-5.4-mini:high
```

The reasoning suffix is optional:

```text
/model claudex:gpt-5.4
```

### Reasoning levels

| Level | Description |
|-------|-------------|
| `low` | Minimal reasoning, fastest responses |
| `medium` | Balanced reasoning |
| `high` | Maximum reasoning depth |

If Claude Code sends adaptive / enabled thinking, Claudex maps that to a Codex reasoning effort automatically. In the absence of an explicit override, the default is `medium`.

---

## Dynamic Model Discovery

On startup, Claudex fetches the live model list from `chatgpt.com/backend-api/codex/models` and caches it. The request includes a Codex `client_version` hint so discovery better matches the backend. If discovery fails, Claudex falls back to its built-in model list.

### View available models

```bash
curl http://localhost:4000/claudex/models
```

### Refresh the model list

```bash
# via API
curl -X POST http://localhost:4000/claudex/models/refresh

# via CLI
claudex --refresh-models
```

### Configure automatic refresh

```bash
CODEX_MODEL_REFRESH_INTERVAL=1800000 claudex  # 30 minutes
```

If your connection to `chatgpt.com` is flaky, you can also tune upstream fetch retries:

```bash
CODEX_API_FETCH_RETRIES=5 CODEX_API_FETCH_RETRY_DELAY_MS=1500 claudex
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API proxy |
| `POST` | `/v1/messages/count_tokens` | Claude-compatible local token estimate |
| `GET` | `/claudex/models` | List discovered models and current tier mapping |
| `POST` | `/claudex/models/refresh` | Refresh the model list from Codex |
| `POST` | `/claudex/config` | Update runtime model / reasoning overrides |
| `GET` | `/health` | Health check |

Examples:

```bash
# health
curl http://localhost:4000/health

# list models
curl http://localhost:4000/claudex/models

# refresh models
curl -X POST http://localhost:4000/claudex/models/refresh

# estimate tokens
curl -X POST http://localhost:4000/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -H "x-api-key: placeholder" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role": "user", "content": "Count this request."}]
  }'

# update runtime config
curl -X POST http://localhost:4000/claudex/config \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.4-mini", "reasoning": "medium"}'

# send a message
curl -X POST http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: placeholder" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## CLI Flags

```text
Usage:
  claudex [options]

Options:
  -p, --port <port>              Port to listen on (default: 4000)
  --model <model>                OpenAI model to use (for example gpt-5.4-mini)
  --reasoning <low|medium|high>  Reasoning intensity level
  --reuse-codex                  Import credentials from existing Codex / opencode installs
  --list-sources                 List detected external credential sources and exit
  --refresh-models               Refresh the model list from the Codex API and exit
  --debug                        Enable debug logging
  -h, --help                     Show help
  -v, --version                  Show version
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CODEX_MODEL` | Force a specific Codex model | Auto-mapped from Claude Code model |
| `CODEX_REASONING` | Force a reasoning level | Auto |
| `CODEX_API_ENDPOINT` | Override Codex Responses API endpoint | `https://chatgpt.com/backend-api/codex/responses` |
| `CODEX_CLIENT_VERSION` | Override the model-discovery `client_version` hint | Auto-detected or `0.115.0` |
| `CODEX_API_FETCH_RETRIES` | Retries for upstream Codex fetch failures | `3` |
| `CODEX_API_FETCH_RETRY_DELAY_MS` | Base retry delay in ms for upstream fetch retries | `1000` |
| `CODEX_MODEL_REFRESH_INTERVAL` | Background model refresh interval in ms | `3600000` |
| `PROXY_PORT` | Default port if `--port` is not provided | `4000` |

---

## Architecture

```text
Claude Code -> POST /v1/messages
     |
     v
  Claudex Proxy
     |
     +- optional local session bridge for resume / continue
     +- convert Anthropic system -> Codex developer
     +- normalize Claude tool schemas
     +- map Claude built-ins and preserve tool transcripts
     +- always talk to Codex with stream=true and store=false
     |
     v
  ChatGPT Codex Responses API
     |
     v
  Claudex converts SSE / JSON back to Anthropic format
     |
     v
  Claude Code receives an Anthropic-compatible response
```

Key implementation details:

- **Tool schema normalization:** Claudex recursively walks nested JSON Schema nodes, strips unsupported keywords, infers missing `type` fields where needed, and emits Codex function tools with `strict: false`.
- **Message conversion:** Anthropic `system` becomes a Codex `developer` message. Tool transcripts are preserved as Codex `function_call` and `function_call_output` items.
- **Claude Code-specific adaptation:** Claudex shortens long MCP-style tool names, restores them in responses, maps `web_search_20250305`, respects `disable_parallel_tool_use`, and preserves structured `tool_result` blocks with text plus images.
- **Streaming:** Claudex always talks to Codex with `stream: true`, then either forwards SSE to Claude Code or aggregates the stream back into a normal JSON response.
- **Resume / continue:** Because Codex continuation is not natively available in the way Claude Code expects here, Claudex reconstructs prior turns from `~/.claude/projects`, matching the active prompt against shell history first and then the live `claude` process command line if needed.
- **Count tokens:** `/v1/messages/count_tokens` uses the same effective request shape, including any local resume / continue session reconstruction.
- **Authentication:** Claudex uses the same OAuth PKCE style flow as Codex CLI / opencode and refreshes tokens in a concurrency-safe way.

---

## Project Structure

```text
src/
  index.ts                  CLI entry point
  server.ts                 HTTP proxy routes and upstream fetch handling
  converter.ts              Anthropic <-> Codex format conversion
  claude-session-bridge.ts  Local resume / continue reconstruction
  oauth.ts                  OAuth PKCE flow and token refresh
  token.ts                  Session persistence and credential discovery
  models.ts                 Dynamic model discovery and tier mapping
  logger.ts                 Structured console logging

tests/
  converter.test.ts              Format conversion coverage
  claude-session-bridge.test.ts  Resume / continue bridge coverage
  server.test.ts                 HTTP proxy route tests
  models.test.ts                 Model discovery tests
  token.test.ts                  Credential parsing tests

Other docs:
  CLAUDE_CODE_COMPATIBILITY.md   Claude Code feature compatibility matrix
```

---

## Acknowledgments

- [sst/opencode](https://github.com/sst/opencode) for Codex API integration references
- [openai/codex](https://github.com/openai/codex) for Codex schema and SSE behavior references
- [anthropics/claude-code](https://github.com/anthropics/claude-code) for the Claude Code client surface
- [cloverich/openclaw](https://github.com/cloverich/openclaw) for cross-reference ideas

---

## License

[GPL-3.0](LICENSE)
