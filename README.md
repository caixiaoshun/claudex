<div align="center">

# ⚡ Claudex

**Bridge Claude Code to ChatGPT Codex — use your ChatGPT subscription as the backend for Claude Code.**

[![npm version](https://img.shields.io/npm/v/@caixiaoshun/claudex.svg)](https://www.npmjs.com/package/@caixiaoshun/claudex)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

</div>

---

## 🤔 What is this?

**Claudex** is a lightweight local proxy that lets you use [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with your existing **ChatGPT Plus/Pro subscription** — no separate Anthropic API key needed.

It works by intercepting Claude Code's API requests, translating them from Anthropic's Messages API format to OpenAI's Responses API format, and forwarding them to ChatGPT's Codex backend. Responses are translated back seamlessly.

### The Pain Point

- You have a **ChatGPT Plus/Pro subscription** with Codex access included
- You want to use **Claude Code's excellent CLI/IDE experience**
- But Claude Code requires an **Anthropic API key** which costs extra
- **Claudex bridges this gap** — one subscription, best of both worlds

---

## ✨ Features

- 🔄 **Bidirectional Format Conversion** — Anthropic Messages API ↔ OpenAI Responses API, automatic and transparent
- 🔐 **OAuth Authorization** — Browser-based PKCE flow for secure ChatGPT login, no API keys to manage
- ♻️ **Reuse Existing Credentials** — If you already use Codex CLI or opencode, import their session with one flag — no browser login needed
- 💾 **Token Persistence** — Sessions cached locally at `~/.codex-proxy/session.json` with auto-refresh
- 🌊 **SSE Streaming** — Full streaming support, converting Codex events to Anthropic `text_delta` format in real-time
- 🛠️ **Tool/Function Calling** — Best-effort conversion of Anthropic tool definitions to OpenAI function calling format
- 📊 **Request Logging** — Every request logged with `[model] [~token estimate] [status]`
- ⚡ **Zero Dependencies** — Built entirely on Node.js standard library (`node:http`, `node:crypto`, `node:fs`)
- 🎯 **Drop-in Compatible** — Just set `ANTHROPIC_BASE_URL` and use Claude Code normally

---

## 🚀 Quick Start

### 1. Install

**Option A — from npm (recommended):**

```bash
npm install -g @caixiaoshun/claudex
```

**Option B — build from source:**

```bash
git clone https://github.com/caixiaoshun/claudex.git
cd claudex
npm install
npm run build
npm install -g .
```

---

### 2. Bypass Claude Code Onboarding

Claude Code v2+ checks for a Claude Pro/Max subscription on first launch and shows a login wizard. Since Claudex replaces the backend entirely, you don't need a Claude subscription — but you do need to tell Claude Code that onboarding is already done.

Run this **once**, before starting Claude Code for the first time:

**macOS / Linux / Windows (any terminal with Node.js):**

```bash
node --eval "
const fs = require('fs'), path = require('path'), os = require('os');
const filePath = path.join(os.homedir(), '.claude.json');
const content = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : {};
fs.writeFileSync(filePath, JSON.stringify({ ...content, hasCompletedOnboarding: true }, null, 2), 'utf-8');
console.log('Done:', filePath);
"
```

This writes `{ "hasCompletedOnboarding": true }` into `~/.claude.json` (or merges it if the file already exists). Claude Code reads this flag on startup and skips the login wizard. It does **not** affect any real Claude credentials — Claudex handles all authentication separately.

---

### 3. Start the Proxy

**If you already use Codex CLI or opencode** (see [Reuse Existing Credentials](#-reuse-existing-credentials)):

```bash
claudex --reuse-codex
```

**Otherwise**, start the proxy and complete the browser login:

```bash
claudex
```

You can optionally specify a model and reasoning level:

```bash
claudex --model gpt-5.1-codex-max --reasoning high
```

Your browser will open for ChatGPT authorization. Log in and approve access — the token is cached for future runs.

---

### 4. Configure Claude Code

Point Claude Code at the local proxy by setting two environment variables. Keep the proxy terminal running and open a **new terminal** for this step.

**macOS / Linux:**

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_API_KEY=sk-ant-placeholder
```

**Windows — PowerShell:**

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:4000"
$env:ANTHROPIC_API_KEY  = "sk-ant-placeholder"
```

**Windows — Command Prompt (cmd.exe):**

```cmd
set ANTHROPIC_BASE_URL=http://localhost:4000
set ANTHROPIC_API_KEY=sk-ant-placeholder
```

> **Note:** Variables set this way only apply to the current terminal session. To make them permanent, see [Persisting Environment Variables](#-persisting-environment-variables).

---

### 5. Use Claude Code Normally

```bash
claude "Help me refactor this function"
```

That's it! Claude Code talks to Claudex, Claudex talks to ChatGPT Codex. 🎉

---

## 💾 Persisting Environment Variables

Avoid re-running the variable commands every time by making them permanent.

**macOS / Linux** — add to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
echo 'export ANTHROPIC_BASE_URL=http://localhost:4000' >> ~/.zshrc
echo 'export ANTHROPIC_API_KEY=sk-ant-placeholder'     >> ~/.zshrc
source ~/.zshrc
```

**Windows — PowerShell (permanent, current user):**

```powershell
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://localhost:4000", "User")
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY",  "sk-ant-placeholder",   "User")
```

**Windows — System Properties GUI:**

1. Open **Start** → search **"Edit environment variables for your account"**
2. Click **New** and add each variable:
   - `ANTHROPIC_BASE_URL` = `http://localhost:4000`
   - `ANTHROPIC_API_KEY` = `sk-ant-placeholder`
3. Click **OK** and restart your terminal

---

## ♻️ Reuse Existing Credentials

If you already have **OpenAI Codex CLI** or **opencode** installed and logged in, Claudex can import their saved session — skipping the browser OAuth flow entirely.

### Check what's available

```bash
claudex --list-sources
```

Example output:

```
Found 2 external credential source(s):

  [1] OpenAI Codex CLI (~/.codex/auth.json)
      Path     : /Users/you/.codex/auth.json
      Expires  : 3/16/2026, 9:00:00 AM (valid)
      Account  : user_abc123

  [2] opencode (~/.opencode/session.json)
      Path     : /Users/you/.opencode/session.json
      Expires  : 3/15/2026, 6:00:00 AM (expired — refresh token will be used)

Run claudex --reuse-codex to automatically import the first valid source.
```

### Import and start

```bash
claudex --reuse-codex
```

Claudex picks the first non-expired source automatically. If the access token has expired, it silently uses the refresh token to obtain a new one — no browser window needed.

### Supported credential locations

| Tool | macOS / Linux | Windows |
|---|---|---|
| OpenAI Codex CLI | `~/.codex/auth.json` | `%USERPROFILE%\.codex\auth.json` |
| opencode | `~/.opencode/session.json` | `%USERPROFILE%\.opencode\session.json` |
| opencode v2 | `~/.opencode/auth/codex.json` | `%USERPROFILE%\.opencode\auth\codex.json` |

---

## ⚙️ Configuration

### Command Line Options

| Option | Description | Default |
|---|---|---|
| `-p, --port <port>` | Port for the proxy server | `4000` |
| `--model <model>` | Codex model to use (e.g. `gpt-5.3-codex`) | auto-mapped |
| `--reasoning <level>` | Reasoning intensity level (`low`, `medium`, or `high`) | auto |
| `--reuse-codex` | Import credentials from an existing Codex / opencode installation | off |
| `--list-sources` | List all detected external credential sources and exit | — |
| `--debug` | Enable verbose debug logging | off |
| `-h, --help` | Show help message | — |
| `-v, --version` | Show version | — |

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `CODEX_MODEL` | Codex model to use | auto-mapped from Anthropic model name |
| `CODEX_REASONING` | Reasoning intensity: `low`, `medium`, or `high` | auto |
| `CODEX_API_ENDPOINT` | Override the Codex API endpoint | `https://chatgpt.com/backend-api/codex/responses` |
| `ANTHROPIC_BASE_URL` | Set on the Claude Code side to point to this proxy | `http://localhost:4000` |
| `ANTHROPIC_API_KEY` | Set on the Claude Code side (any `sk-ant-` prefixed value works) | — |

### Available Codex Models

| Model | Tier | Description |
|---|---|---|
| `gpt-5.3-codex` | Mid | Default, best balance of speed and quality |
| `gpt-5.2-codex` | Mid | Previous generation Codex model |
| `gpt-5.1-codex` | Mid | GPT-5.1 based Codex model |
| `gpt-5.1-codex-max` | High | Highest capability Codex model with maximum reasoning |
| `gpt-5.1-codex-mini` | Fast | Lightweight fast Codex model |
| `gpt-5.2` | Mid | General GPT-5.2 model |
| `gpt-5.4` | High | Latest GPT-5.4 model |

When no model is explicitly configured, Claudex automatically maps Anthropic model names:
- `claude-*-opus-*` → `gpt-5.1-codex-max` (highest capability)
- `claude-*-sonnet-*` → `gpt-5.3-codex` (balanced)
- `claude-*-haiku-*` → `gpt-5.1-codex-mini` (fastest)

---

## 🧠 Model Selection & Reasoning

Claudex supports multiple ways to select a Codex model and control reasoning intensity.

### At startup (CLI flags)

```bash
claudex --model gpt-5.3-codex --reasoning high
```

### Via environment variables

```bash
CODEX_MODEL=gpt-5.3-codex CODEX_REASONING=high claudex
```

### At runtime (API endpoint)

Update the model and reasoning level without restarting the proxy:

```bash
curl -X POST http://localhost:4000/claudex/config \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.1-codex-max", "reasoning": "high"}'
```

### Via Claude Code's `/model` command

Use the `claudex:` prefix convention to switch models from within Claude Code:

```
/model claudex:gpt-5.3-codex:high
/model claudex:gpt-5.1-codex-max
/model claudex:gpt-5.1-codex-mini:low
```

Format: `claudex:<codex-model-name>:<reasoning-level>`

The reasoning level is optional. Valid values: `low`, `medium`, `high`.

### Reasoning intensity

When Claudex detects that Claude Code sends Anthropic's `thinking` / extended thinking configuration, it automatically maps it to a Codex reasoning level:

| Anthropic thinking budget | Codex reasoning |
|---|---|
| `budget_tokens >= 10000` | `high` |
| `budget_tokens >= 5000` | `medium` |
| `budget_tokens < 5000` | `low` |
| thinking enabled, no budget | `medium` |

---

## 🔧 How It Works

```
┌─────────────────┐     Anthropic      ┌──────────────┐      OpenAI       ┌──────────────────┐
│                  │   Messages API     │              │   Responses API   │                  │
│   Claude Code    │ ─────────────────▶ │    Claudex   │ ────────────────▶ │  ChatGPT Codex   │
│   (CLI / IDE)    │ ◀───────────────── │    Proxy     │ ◀──────────────── │  (OAuth Backend) │
│                  │   SSE / JSON       │  :4000       │   SSE / JSON      │                  │
└─────────────────┘                     └──────────────┘                    └──────────────────┘

Request Flow:
  1. Claude Code sends POST /v1/messages (Anthropic format)
  2. Claudex converts to OpenAI Responses API format
  3. Request forwarded to chatgpt.com/backend-api/codex/responses
  4. Response streamed back, converted to Anthropic SSE events
  5. Claude Code receives familiar Anthropic-format response

Auth Flow — Browser (first run, no existing credentials):
  1. Claudex opens browser → auth.openai.com (PKCE OAuth)
  2. User logs in with ChatGPT account
  3. Callback received, tokens exchanged and cached at ~/.codex-proxy/session.json
  4. Auto-refresh on expiry, no manual intervention needed

Auth Flow — Reuse (--reuse-codex):
  1. Claudex scans known credential locations (see table above)
  2. Imports the first valid session into ~/.codex-proxy/session.json
  3. If access token is expired, refresh token is used automatically
  4. No browser window opened
```

### Format Conversion Details

**Request Mapping:**

| Anthropic | → | OpenAI Responses API | Notes |
|---|---|---|---|
| `messages[]` | → | `input[]` | Role and content converted |
| `system` (string or array) | → | `instructions` | Array entries joined with newline |
| `tools[].input_schema` | → | `tools[].function.parameters` | Wrapped in `type: "function"` |
| `stream: true` | → | `stream: true` | Direct passthrough |
| — | → | `store: false` | Always set (required by Codex) |
| — | → | `tool_choice: "auto"` | Set when tools are present |
| — | → | `parallel_tool_calls: true` | Set when tools are present |
| `thinking.budget_tokens` | → | `reasoning.effort` | Mapped to low/medium/high |

**Fields stripped (not supported by Codex Responses API):**

`max_tokens`, `temperature`, `top_p`, `stop_sequences`, `metadata`, `betas`, `thinking`, `stream_options`

**Streaming Event Mapping:**

| Codex Event | → | Anthropic Event |
|---|---|---|
| `response.created` | → | *(acknowledged, no output)* |
| `response.output_text.delta` | → | `content_block_delta` (text_delta) |
| `response.output_text.done` | → | `content_block_stop` |
| `response.output_item.done` | → | `content_block_start/stop` (tool_use) |
| `response.output_item.added` | → | *(acknowledged, no output)* |
| `response.completed` | → | `message_delta` + `message_stop` |
| `response.failed` | → | `error` + `message_stop` |
| `response.incomplete` | → | `message_delta` (stop_reason: max_tokens) + `message_stop` |
| `response.reasoning_summary_text.delta` | → | *(acknowledged, no output)* |
| `response.reasoning_text.delta` | → | *(acknowledged, no output)* |

### Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/messages` | Main proxy route (Anthropic Messages API) |
| `GET` | `/claudex/models` | List available Codex models with descriptions |
| `POST` | `/claudex/config` | Update runtime model/reasoning configuration |
| `GET` | `/health` | Health check |

**Example: List models**

```bash
curl http://localhost:4000/claudex/models
```

**Example: Update runtime config**

```bash
curl -X POST http://localhost:4000/claudex/config \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.3-codex", "reasoning": "high"}'
```

---

## 📁 Project Structure

```
claudex/
├── src/
│   ├── index.ts        # CLI entry point, argument parsing, --model / --reasoning / --reuse-codex
│   ├── server.ts       # HTTP proxy server (POST /v1/messages, GET /claudex/models, POST /claudex/config)
│   ├── oauth.ts        # ChatGPT OAuth (PKCE flow + token refresh)
│   ├── token.ts        # Session persistence + external credential detection
│   ├── converter.ts    # Bidirectional format converter + SSE stream converter + model mapping
│   └── logger.ts       # Structured logging with colors
├── tests/
│   ├── converter.test.ts   # Unit tests for format conversion, model mapping, streaming
│   └── token.test.ts       # Unit tests for credential parsing
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🙏 Acknowledgments

This project draws inspiration and technical reference from:

- **[opencode](https://github.com/sst/opencode)** — The open source coding agent by SST, whose Codex OAuth plugin implementation (`codex.ts`) served as the primary reference for OAuth flow, API endpoints, and token management
- **[OpenClaw](https://github.com/cloverich/openclaw)** — Referenced for Codex integration patterns

Key technical details borrowed from these projects:
- OAuth Client ID and PKCE flow parameters
- Codex API endpoint (`chatgpt.com/backend-api/codex/responses`)
- Token refresh mechanism and JWT claim parsing for account ID extraction

---

## 📄 License

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

**Built with ❤️ for developers who want the best of both worlds.**

*Claude Code's UX + ChatGPT's Codex — bridged by Claudex.*

</div>
