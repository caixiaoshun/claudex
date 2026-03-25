# Claude Code Live E2E Report

Generated: 2026-03-25T09:12:00+08:00

Environment:

- Claude Code CLI: `2.1.76`
- Claudex proxy: local `http://localhost:4000`
- Backend: ChatGPT Codex via Claudex
- Platform: Windows / PowerShell

| Test | Result | Notes |
| --- | --- | --- |
| `models-endpoint` | PASS | `/claudex/models` returned live tier mapping and model list |
| `print-mode` | PASS | `claude -p` returned `PRINT-OK` through Claudex |
| `json-output` | PASS | Claude Code JSON output mode returned `JSON-OK` |
| `stream-json-output` | PASS | Claude Code stream-json mode returned `STREAM-OK` and assistant events |
| `custom-model-override` | PASS | Direct Anthropic request with `claudex:gpt-5.4:high` resolved to `gpt-5.4` with `high` reasoning |
| `claude-md-memory` | PASS | Project `CLAUDE.md` memory returned `CLAUDEX-MEMORY-OK` |
| `auto-skill` | PASS | Project skill metadata surfaced in Claude Code session init |
| `legacy-command` | PASS | Custom legacy slash command returned `LEGACY-COMMAND-OK:alpha beta` |
| `skill-command` | PASS | Skill-backed slash command returned `SKILL-COMMAND-OK:gamma delta` |
| `plugin-install-and-load` | PASS | Marketplace plugin `feature-dev@claude-plugins-official` installed and surfaced plugin commands/agents |
| `agents-list` | PASS | Custom agent `claudex-sentinel` listed by `claude agents` |
| `subagent-delegation` | PASS | Agent tool delegated to `claudex-sentinel` and returned `AGENT-E2E-HIT` |
| `todo-and-file-tools` | PASS | Claude Code used `TodoWrite` and `Write`; file artifact content verified as `TODO-FILE-OK` |
| `hooks` | PASS | Hook matching for `PostToolUse` `Write` observed in debug trace; task completed with `HOOK-DONE` |
| `mcp-config-cli` | PASS | `claude mcp add -s project` wrote project `.mcp.json` for `claudex-e2e` |
| `mcp-tool` | PASS | MCP tool call returned `MCP_TOOL_OK:demo` and debug trace showed live MCP connection |
| `mcp-resource` | PASS | MCP resource read returned `MCP_RESOURCE_OK` |
| `mcp-prompt` | PASS | MCP prompt slash command returned `MCP_PROMPT_OK:topic42` in stream-json mode |
| `resume` | PASS | Stored token was recovered via `--resume <session-id>` and returned `SESSION-E2E-42` |
| `continue` | PASS | `--continue` preserved session context and returned `CONTINUE-OK` |

Notes:

- `claude mcp list` / `claude mcp get` did not reliably enumerate project-scope `.mcp.json` state in this Claude Code version, so MCP validation used the actual project config file plus live tool/resource/prompt execution.
- Some text-mode outputs were intermittently swallowed by the current Claude Code CLI, so the most timing-sensitive checks (`mcp-prompt`, `resume`, `continue`) were validated through Claude Code's real `stream-json` event stream.
