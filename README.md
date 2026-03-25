<div align="center">

# ⚡ Claudex

**Bridge Claude Code to ChatGPT Codex — use your ChatGPT subscription as the backend for Claude Code.**

[![npm version](https://img.shields.io/npm/v/@caixiaoshun/claudex.svg)](https://www.npmjs.com/package/@caixiaoshun/claudex)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

</div>

---

## What is this?

**Claudex** is a zero-dependency local proxy that lets you use [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with your existing **ChatGPT Plus/Pro subscription** — no separate Anthropic API key needed.

It intercepts Claude Code's API requests (`POST /v1/messages` in Anthropic format), transforms them to the exact format the [Codex Responses API](https://chatgpt.com/backend-api/codex/responses) expects, and translates responses back to Anthropic format. Both streaming and non-streaming are fully supported.

### Why?

- You have a **ChatGPT Plus/Pro subscription** with Codex access included
- You want to use **Claude Code's excellent CLI/IDE experience**
- But Claude Code requires an **Anthropic API key** which costs extra
- **Claudex bridges this gap** — one subscription, best of both worlds

---

## Installation

```bash
npm install -g @caixiaoshun/claudex
```

Or clone and build from source:

```bash
git clone https://github.com/caixiaoshun/claudex.git
cd claudex
npm install
npm run build
```

---

## Recent Updates

- Startup logs now print the live Claude-to-GPT tier mapping directly, including an explicit `sonnet4.6 -> ...` line so it is obvious which GPT model Claude Code is really using.
- The default `opus` / `sonnet` / `haiku` mapping has been refreshed to the current GPT-5.4 family: `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.4-nano`.
- Dynamic model discovery is more reliable now: Claudex sends the Codex `client_version` hint when fetching `/codex/models`, and live discovery prefers GPT-5.4 family models before older Codex fallbacks.
- Claude Code image inputs now work end to end. Anthropic image blocks are converted into Responses API `input_image` items for both remote URLs and base64 screenshots.
- A real Windows Claude Code compatibility harness was added for live verification of print/json/stream mode, custom model overrides, `CLAUDE.md` memory, skills, slash commands, plugins, custom agents and subagents, todo/file workflows, hook triggering, MCP config/tools/resources/prompts, and session `resume` / `continue`.
- Documentation was updated to reflect the refreshed mappings, the new startup visibility, the live compatibility audit, and the wider official Claude Code feature surface around automation and session handoff.

---

## Quick Start

### Step 1: Bypass Claude Code Onboarding

Claude Code requires onboarding to be completed. Run this once:

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

### Step 2: Start the Claudex Proxy

```bash
claudex
```

On first run, your browser will open for ChatGPT OAuth login. After authorization, the proxy starts on port 4000 (default).

### Step 3: Configure Claude Code

Set these environment variables before running Claude Code:

**macOS / Linux:**

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_API_KEY=sk-ant-placeholder
```

**Windows (PowerShell):**

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:4000"
$env:ANTHROPIC_API_KEY = "sk-ant-placeholder"
```

**Windows (CMD):**

```cmd
set ANTHROPIC_BASE_URL=http://localhost:4000
set ANTHROPIC_API_KEY=sk-ant-placeholder
```

### Step 4: Use Claude Code Normally

```bash
claude "Help me refactor this function"
```

All requests flow through the proxy to ChatGPT Codex.

---

## Credential Reuse

If you already have Codex CLI or opencode installed and logged in, you can skip the browser OAuth flow:

```bash
claudex --reuse-codex
```

This searches for existing credentials in:

| Source | Path |
|--------|------|
| OpenAI Codex CLI | `~/.codex/auth.json` |
| opencode | `~/.opencode/session.json` |
| opencode v2 | `~/.opencode/auth/codex.json` |

To see which credential files are detected:

```bash
claudex --list-sources
```

---

## Windows E2E Verification

To validate a source checkout against a real Claude Code session on Windows:

1. Build the project:

```powershell
npm install
npm run build
```

2. Start the proxy with credential reuse and debug logging:

```powershell
claudex --reuse-codex --debug
```

3. In a second PowerShell window, point Claude Code at the local proxy:

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:4000"
$env:ANTHROPIC_API_KEY = "sk-ant-placeholder"
```

If Claude Code's local `WebFetch` tool fails on Windows with `unable to get local issuer certificate`, that is a local Node.js trust-store issue rather than a Claudex proxy issue. For a quick validation-only workaround, launch Claude Code with:

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
```

Prefer installing the correct enterprise/root certificate for a permanent fix.

4. Run Claude Code and exercise the built-in tools with prompts such as:

- `Run "pwd" and tell me the result.`
- `Fetch https://example.com and summarize it.`
- `Delegate a small subtask to another agent and return its summary.`
- `Plan a small code change, ask me one multiple-choice clarification if needed, then exit plan mode for approval.`
- `Create and maintain a todo list while doing a multi-step task.`
- `Read a scratch file, make a small edit, and show the result.`

Successful validation means the entire session completes with streamed output visible in Claude Code, tool results render normally, and the proxy debug log shows zero `Codex API error: 400` entries.

---

## Model Selection & Reasoning

### Automatic Tier Mapping

Claudex automatically maps Anthropic model names to the best available OpenAI model:

| Claude Code sends | Claudex uses |
|-------------------|--------------|
| `claude-opus-*` | Highest capability (currently `gpt-5.4`) |
| `claude-*-sonnet-*` | Balanced/default (currently `gpt-5.4-mini`) |
| `claude-*-haiku-*` | Fastest/lightest (currently `gpt-5.4-nano`) |

When live model discovery succeeds, Claudex prefers the current GPT-5.4 family first and then falls back to older Codex-specialized models only if those newer models are unavailable.

### Override at Startup

```bash
claudex --model gpt-5.4-mini --reasoning high
```

### Override via Environment Variables

```bash
CODEX_MODEL=gpt-5.4-mini CODEX_REASONING=high claudex
```

### Override at Runtime

```bash
curl -X POST http://localhost:4000/claudex/config \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.4-mini", "reasoning": "high"}'
```

### Via Claude Code's `/model` Command

Use the `claudex:<model>:<reasoning>` convention:

```
/model claudex:gpt-5.4-mini:high
```

The reasoning parameter is optional:

```
/model claudex:gpt-5.4
```

### Reasoning Intensity Levels

| Level | Description |
|-------|-------------|
| `low` | Minimal reasoning, fastest responses |
| `medium` | Balanced reasoning (default if thinking is enabled) |
| `high` | Maximum reasoning depth |

---

## Dynamic Model Discovery

On startup, Claudex fetches the live model list from the Codex API (`chatgpt.com/backend-api/codex/models`) and caches it. If the endpoint is unreachable, it falls back to a hardcoded default list.

### View Available Models

```bash
curl http://localhost:4000/claudex/models
```

### Refresh Model List

```bash
# Via API
curl -X POST http://localhost:4000/claudex/models/refresh

# Via CLI
claudex --refresh-models
```

### Automatic Refresh

Models are refreshed automatically every hour by default. Configure with:

```bash
CODEX_MODEL_REFRESH_INTERVAL=1800000 claudex  # 30 minutes
```

If your network to `chatgpt.com` is flaky, you can also tune upstream response retries:

```bash
CODEX_API_FETCH_RETRIES=5 CODEX_API_FETCH_RETRY_DELAY_MS=1500 claudex
```

---

## All API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API proxy (main endpoint) |
| `GET` | `/claudex/models` | List available Codex models and tier mapping |
| `POST` | `/claudex/models/refresh` | Re-fetch the model list from Codex API |
| `POST` | `/claudex/config` | Update runtime model/reasoning configuration |
| `GET` | `/health` | Health check |

### Examples

```bash
# Health check
curl http://localhost:4000/health

# List models
curl http://localhost:4000/claudex/models

# Refresh models
curl -X POST http://localhost:4000/claudex/models/refresh

# Update config
curl -X POST http://localhost:4000/claudex/config \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.4-mini", "reasoning": "medium"}'

# Send a message (Anthropic format)
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

```
Usage:
  claudex [options]

Options:
  -p, --port <port>              Port to listen on (default: 4000)
  --model <model>                OpenAI model to use (e.g. gpt-5.4-mini)
  --reasoning <low|medium|high>  Reasoning intensity level
  --reuse-codex                  Import credentials from existing Codex/opencode install
  --list-sources                 List detected external credential sources and exit
  --refresh-models               Refresh the model list from the Codex API and exit
  --debug                        Enable debug logging
  -h, --help                     Show help message
  -v, --version                  Show version
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CODEX_MODEL` | OpenAI model to use | Auto-mapped from Claude Code model |
| `CODEX_REASONING` | Reasoning intensity (`low`, `medium`, `high`) | Auto |
| `CODEX_API_ENDPOINT` | Override Codex API endpoint | `https://chatgpt.com/backend-api/codex/responses` |
| `CODEX_MODEL_REFRESH_INTERVAL` | Model refresh interval in ms | `3600000` (1 hour) |
| `PROXY_PORT` | Default port (overridden by `--port`) | `4000` |

---

## Architecture

```
Claude Code  →  POST /v1/messages (Anthropic format)
     │
     ▼
  Claudex Proxy (localhost:4000)
     │
     ├─ Strip Anthropic-specific fields (betas, metadata, thinking, etc.)
     ├─ Normalize tool schemas recursively at every nesting level
     ├─ Convert tools: enforce backend-compatible required keys, force additionalProperties=false on object schemas, strict=true
     ├─ Map model: opus→max, sonnet→balanced, haiku→mini
     ├─ Build Codex request: model, instructions, input, tools, store=false
     │
     ▼
  ChatGPT Codex API (chatgpt.com/backend-api/codex/responses)
     │
     ▼
  Claudex converts response back to Anthropic format
     │
     ▼
  Claude Code receives Anthropic-format response
```

### Key Implementation Details

**Tool Schema Normalization:** Tool parameter schemas are normalized bottom-up at **every schema node** before forwarding to the Codex API. Claudex first recurses through nested `properties`, schema-valued `additionalProperties`, `items`, `anyOf`, rejected combinators such as `oneOf` / `allOf`, plus unsupported schema containers such as `patternProperties`, `$defs` / `definitions`, `not`, and conditionals (`if` / `then` / `else`), then repairs the current node. Missing `type` is inferred as `object` when `properties` exist, `array` when `items` exist, and `object` otherwise. At every object node with `properties`, `required` is normalized to the exact set of Codex-counted property keys: regular fields stay required, while pure record/map containers (object schemas that only expose schema-valued `additionalProperties`) and stripped empty object shells (for example, properties left behind after `oneOf` / `allOf` are removed) stay optional because Codex rejects them in `required`. `additionalProperties` is forced to `false` on every non-record object node. After normalization, only accepted JSON Schema keywords (`type`, `description`, `properties`, `required`, `additionalProperties`, `items`, `anyOf`, `enum`, `const`, `default`, `nullable`, `title`) are kept in the final payload. Unsupported fields such as `format`, `$schema`, `$id`, `$ref`, `examples`, `pattern`, `minLength`, `maxLength`, `contentEncoding`, `contentMediaType`, `patternProperties`, `$defs`, `definitions`, `if`, `then`, `else`, `oneOf`, and `allOf` are stripped before the request is sent.

**Field Stripping:** Only whitelisted top-level fields are forwarded to Codex: `model`, `instructions`, `input`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `store`, `stream`, `include`, `service_tier`, `prompt_cache_key`, and `text`. Everything else is stripped before the request is sent.

**Tool History Conversion:** Multi-turn Claude tool transcripts are converted into Codex-compatible top-level `input` items. Assistant `tool_use` blocks become standalone `function_call` items with a preserved `call_id`, and user `tool_result` blocks become standalone `function_call_output` items. Claudex intentionally omits `function_call.id` when replaying history, because Codex rejects Claude-style `call_*` IDs in that field.

**SSE Streaming:** Claudex now always talks to Codex with `stream: true`, because the Codex backend rejects non-streaming requests. Anthropic streaming requests are forwarded as SSE, while Anthropic non-streaming requests are aggregated from the Codex SSE stream back into a normal JSON message. All Codex SSE event types are handled: `response.created`, `response.output_text.delta`, `response.output_text.done`, `response.output_item.added`, `response.output_item.done`, `response.completed`, `response.failed`, `response.incomplete`, `response.reasoning_summary_text.delta`, `response.reasoning_text.delta`, `response.reasoning_summary_part.added`.

**Authentication:** Uses the same OAuth PKCE flow as opencode/Codex CLI. Token refresh is concurrent-safe — simultaneous expired-token requests share a single refresh promise.

---

## Project Structure

```
src/
  index.ts       CLI entry point with all flags
  server.ts      HTTP proxy server with route handling
  converter.ts   Bidirectional Anthropic ↔ Codex format conversion
  oauth.ts       OAuth PKCE flow with concurrent-safe token refresh
  token.ts       Session persistence and external credential detection
  models.ts      Dynamic model discovery and tier mapping
  logger.ts      Structured console logging
tests/
  converter.test.ts  Format conversion tests
  models.test.ts     Model discovery tests
  token.test.ts      Credential parsing tests
```

---

## Acknowledgments

- [sst/opencode](https://github.com/sst/opencode) — Ground truth for Codex API integration
- [openai/codex](https://github.com/openai/codex) — Codex API schema and SSE event types
- [anthropics/claude-code](https://github.com/anthropics/claude-code) — Claude Code client
- [cloverich/openclaw](https://github.com/cloverich/openclaw) — Cross-reference implementation

---

## License

[GPL-3.0](LICENSE)
