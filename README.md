<div align="center">

# ⚡ Claudex

**Bridge Claude Code to ChatGPT Codex — use your ChatGPT subscription as the backend for Claude Code.**

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
- 💾 **Token Persistence** — Sessions cached locally at `~/.codex-proxy/session.json` with auto-refresh
- 🌊 **SSE Streaming** — Full streaming support, converting Codex events to Anthropic `text_delta` format in real-time
- 🛠️ **Tool/Function Calling** — Best-effort conversion of Anthropic tool definitions to OpenAI function calling format
- 📊 **Request Logging** — Every request logged with `[model] [~token estimate] [status]`
- ⚡ **Zero Dependencies** — Built entirely on Node.js standard library (`node:http`, `node:crypto`, `node:fs`)
- 🎯 **Drop-in Compatible** — Just set `ANTHROPIC_BASE_URL` and use Claude Code normally

---

## 🚀 Quick Start

### 1. Clone and Build

```bash
git clone https://github.com/caixiaoshun/claudex.git
cd claudex
npm install
npm run build
```

### 2. Start the Proxy

```bash
node dist/index.js
```

On first run, your browser will open for ChatGPT authorization. Log in and approve access — the token is cached for future use.

### 3. Configure Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_API_KEY=placeholder
```

### 4. Use Claude Code Normally

```bash
claude "Help me refactor this function"
```

That's it! Claude Code talks to Claudex, Claudex talks to ChatGPT Codex. 🎉

---

## ⚙️ Configuration

### Command Line Options

| Option | Description | Default |
|---|---|---|
| `-p, --port <port>` | Port for the proxy server | `4000` |
| `--debug` | Enable verbose debug logging | off |
| `-h, --help` | Show help message | — |
| `-v, --version` | Show version | — |

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `CODEX_MODEL` | Codex model to use | `gpt-5.3-codex` |
| `CODEX_API_ENDPOINT` | Override the Codex API endpoint | `https://chatgpt.com/backend-api/codex/responses` |
| `ANTHROPIC_BASE_URL` | Set on the Claude Code side to point to this proxy | `http://localhost:4000` |
| `ANTHROPIC_API_KEY` | Set on the Claude Code side (any non-empty value works) | — |

### Available Codex Models

| Model | Description |
|---|---|
| `gpt-5.3-codex` | Default, best balance of speed and quality |
| `gpt-5.1-codex` | Stable Codex model |
| `gpt-5.1-codex-mini` | Faster, lighter variant |
| `gpt-5.1-codex-max` | Maximum capability |
| `gpt-5.2-codex` | GPT-5.2 based Codex |
| `gpt-5.4` | Latest model |

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

Auth Flow (first run):
  1. Claudex opens browser → auth.openai.com (PKCE OAuth)
  2. User logs in with ChatGPT account
  3. Callback received, tokens exchanged and cached
  4. Auto-refresh on expiry, no manual intervention needed
```

### Format Conversion Details

**Request Mapping:**
| Anthropic | → | OpenAI Responses API |
|---|---|---|
| `messages[]` | → | `input[]` |
| `system` | → | `instructions` |
| `max_tokens` | → | `max_output_tokens` |
| `tools[].input_schema` | → | `tools[].function.parameters` |
| `stream: true` | → | `stream: true` |

**Streaming Event Mapping:**
| Codex Event | → | Anthropic Event |
|---|---|---|
| `response.output_text.delta` | → | `content_block_delta` (text_delta) |
| `response.output_text.done` | → | `content_block_stop` |
| `response.output_item.done` | → | `content_block_start/stop` (tool_use) |
| `response.completed` | → | `message_delta` + `message_stop` |

---

## 📁 Project Structure

```
claudex/
├── src/
│   ├── index.ts        # CLI entry point & argument parsing
│   ├── server.ts       # HTTP proxy server (POST /v1/messages)
│   ├── oauth.ts        # ChatGPT OAuth (PKCE flow + token refresh)
│   ├── token.ts        # Session persistence (~/.codex-proxy/session.json)
│   ├── converter.ts    # Bidirectional format converter + SSE stream converter
│   └── logger.ts       # Structured logging with colors
├── tests/
│   └── converter.test.ts   # Unit tests for format conversion
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