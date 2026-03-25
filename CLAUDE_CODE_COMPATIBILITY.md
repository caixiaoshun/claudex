# Claude Code Compatibility Matrix

Last audited: 2026-03-25

This document tracks which Claude Code CLI capabilities were checked against
`claudex`, what part of the proxy they depend on, and how they are validated in
this repository.

## Sources

- Claude Code overview: <https://code.claude.com/docs/en/overview>
- CLI reference: <https://code.claude.com/docs/en/cli-reference>
- Built-in commands: <https://code.claude.com/docs/en/commands>
- Tools reference: <https://code.claude.com/docs/en/tools-reference>
- Skills: <https://code.claude.com/docs/en/skills>
- MCP: <https://code.claude.com/docs/en/mcp>
- Memory: <https://code.claude.com/docs/en/memory>
- Subagents: <https://code.claude.com/docs/en/sub-agents>
- Hooks: <https://code.claude.com/docs/en/hooks>
- Remote Control: <https://code.claude.com/docs/en/remote-control>
- GitHub Actions: <https://code.claude.com/docs/en/github-actions>
- Release notes: <https://docs.anthropic.com/en/release-notes/claude-code>

## Compatibility Summary

| Claude Code capability | Claude Code behavior | Proxy impact | Claudex status | Validation |
|---|---|---|---|---|
| Interactive CLI / prompt mode | `claude`, `claude "prompt"` | Anthropic `/v1/messages` transport | Supported | Existing request/response and streaming tests |
| Print / SDK mode | `claude -p`, `--output-format json|stream-json` | Same API, often non-interactive | Supported | Live E2E against installed Claude Code 2.1.76 |
| Resume / continue | `claude -c`, `claude -r` | Same API; client-side session state | Supported | Live E2E in a clean persisted session directory |
| `/model` and effort changes | Built-in slash command changes model/effort immediately | Model string + reasoning mapping | Supported | `parseClaudexModelString` and `mapModel` tests |
| CLAUDE.md and auto memory | Loaded as session context | Arrives as system/instruction text | Supported | Live E2E + system prompt conversion tests |
| Skills and custom commands | Prompt-side orchestration and slash commands | Skill content becomes prompt/tool usage | Supported | Live E2E for auto-loaded skills and slash commands |
| Plugins / marketplace extensions | Plugins contribute commands, prompts, and agents | Same prompt/tool/session metadata path | Supported | Live E2E plugin install/load with surfaced plugin commands and agents |
| MCP tools | Regular callable tools named like `mcp__server__tool` | Tool schema normalization + tool call roundtrip | Supported | Live E2E + MCP schema/name preservation tests |
| MCP resources | Internal tools such as `ReadMcpResourceTool`; `@server:uri` references | Generic tool schema + text attachments | Supported | Live E2E resource reads + generic tool schema handling |
| MCP prompts | Dynamic slash commands like `/mcp__server__prompt` | Prompt-side only | Supported | Live E2E via stream-json slash-command invocation |
| Subagents / agent teams | `Agent` tool, `claude agents`, built-in Explore/Plan agents | Tool schema normalization + tool results | Supported | Live E2E delegation + added `Agent` fixture coverage |
| Plan mode / elicitation | `AskUserQuestion`, `ExitPlanMode` | Tool schema normalization + tool roundtrip | Supported | Existing real-schema integration tests |
| Todo / task management | `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `TodoWrite` | Tool schema normalization + tool roundtrip | Supported | Live E2E TodoWrite workflow + existing Task tests |
| Bash / file tools | `Bash`, `Read`, `Edit`, etc. | Tool schema normalization + tool roundtrip | Supported | Added Bash/Read/Edit fixture coverage; live E2E Write path |
| Web tools | `WebFetch`, `WebSearch` | Tool schema normalization + tool roundtrip | Supported | Existing `WebFetch` integration tests |
| Image input / screenshots | User image blocks and visual workflows | Multimodal message conversion | Supported | Added URL/base64 image conversion tests |
| `/loop`, `/schedule`, and CI-style automation | Repeated or scheduled non-interactive Claude Code runs | Same headless `/v1/messages` transport plus client scheduling | Supported at proxy layer | Live E2E covers the underlying `claude -p` transport; scheduling remains Claude Code-owned |
| Remote Control, `/desktop`, `/teleport`, Channels, Dispatch | Session handoff between terminal, desktop, web, mobile, and chat surfaces | Same persisted session + API transport once the client reconnects | Supported at proxy layer | Live E2E resume/continue validates the shared session path; orchestration UX is client-owned |
| Hooks | Lifecycle automation, including MCP-aware hooks | Client-side behavior around tool execution | Supported | Live E2E debug-trace verification for `PostToolUse` hook matching |
| GitHub Actions / GitLab CI | Runs Claude Code in workflows | External runtime invoking the same headless CLI path | Supported at protocol layer | Covered by the same live `claude -p` transport exercised in E2E |

## What Was Verified In Code

### Protocol conversions

- Anthropic request -> OpenAI Responses request conversion
- OpenAI response -> Anthropic response conversion
- SSE streaming conversion
- Runtime model overrides and `claudex:<model>:<reasoning>` parsing

Files:

- `src/converter.ts`
- `src/models.ts`
- `src/server.ts`

### Tool and schema compatibility

The converter now has explicit regression coverage for representative Claude Code
internal tools and workflows:

- `Agent`
- `AskUserQuestion`
- `ExitPlanMode`
- `Bash`
- `Read`
- `Edit`
- `Skill`
- `TaskCreate`
- `TodoWrite`
- `WebFetch`
- `ListMcpResourcesTool`
- `ReadMcpResourceTool`
- `mcp__github__create_issue` as a representative MCP tool name

### Multimodal compatibility

`claudex` now converts Anthropic image blocks into Responses API
`input_image` content for:

- Remote image URLs
- Base64 data URLs

This closes a real feature gap for screenshot and vision-style Claude Code
workflows.

## Live E2E Status

An installed Claude Code CLI (`2.1.76`) was exercised against Claudex on
Windows with a real local proxy and real Claude Code commands. The live checks
covered:

- `claude -p` in text / json / stream-json modes
- startup model mapping visibility and runtime `claudex:<model>:<reasoning>`
  overrides
- `CLAUDE.md` memory
- project skills and slash commands
- marketplace plugin install / load
- custom agent listing and subagent delegation
- `TodoWrite` plus file creation
- hook trigger matching in debug traces
- project MCP config plus live MCP tool / resource / prompt execution
- session persistence via `resume` and `continue`

These live runs cover the proxy-relevant paths behind higher-level Claude Code
surfaces such as `/loop`, `/schedule`, GitHub Actions, GitLab CI, `/desktop`,
`/teleport`, Remote Control, Channels, and Dispatch. Those experiences add
their own scheduling or handoff UX, but they still reconnect through the same
message transport and persisted session plumbing exercised above.

## Residual Risks

- This audit validates proxy compatibility, not every Claude Code client UX
  surface. Features like `/agents`, `/mcp`, `/hooks`, `claude remote-control`,
  and GitHub Actions still depend on Claude Code itself behaving correctly.
- The current Claude Code CLI has a few client-side quirks that are not proxy
  regressions: project-scope `claude mcp list/get` did not reliably enumerate
  `.mcp.json`, and some text-mode slash-command/session outputs were more stable
  when validated through `stream-json`.
- Future Claude Code releases can add new internal tools or new JSON Schema
  keywords. The schema sanitizer is intentionally whitelist-based to reduce this
  risk, but new capabilities should still be added to fixture coverage when they
  appear.
