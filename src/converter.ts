/**
 * Format converter — bidirectional conversion between Anthropic Messages API and OpenAI Responses API
 * 格式转换器 — Anthropic Messages API 与 OpenAI Responses API 之间的双向转换
 *
 * Anthropic Messages API: https://docs.anthropic.com/en/api/messages
 * OpenAI Responses API: https://platform.openai.com/docs/api-reference/responses
 */

import * as crypto from "node:crypto";

// ---------- Anthropic Types ----------

export interface AnthropicTextContent {
  type: "text";
  text: string;
}

export interface AnthropicImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface AnthropicToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | AnthropicTextContent
  | AnthropicImageContent
  | AnthropicToolUseContent
  | AnthropicToolResultContent;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  tools?: AnthropicTool[];
  stop_sequences?: string[];
  metadata?: Record<string, unknown>;
  // Anthropic-specific fields that Claude Code may send (must be stripped)
  betas?: string[];
  thinking?: Record<string, unknown>;
  stream_options?: Record<string, unknown>;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface AnthropicErrorResponse {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}

// ---------- OpenAI Responses API Types ----------

interface OpenAIInputMessage {
  role: "user" | "assistant" | "system" | "developer";
  content: string | OpenAIContentPart[];
}

interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  // tool-related fields
  id?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface CodexReasoning {
  effort?: "low" | "medium" | "high";
  summary?: "auto" | "concise" | "detailed";
}

interface OpenAIResponsesRequest {
  model: string;
  instructions?: string;
  input: OpenAIInputMessage[];
  store: boolean;
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  reasoning?: CodexReasoning;
  include?: string[];
}

// ---------- Model Mapping ----------

const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";

/**
 * Available Codex models — sourced from the openai/codex and opencode repositories.
 */
export const CODEX_MODELS: Record<
  string,
  { name: string; description: string; tier: "high" | "mid" | "fast" }
> = {
  "gpt-5.3-codex": {
    name: "GPT-5.3 Codex",
    description: "Default balanced model for coding tasks",
    tier: "mid",
  },
  "gpt-5.2-codex": {
    name: "GPT-5.2 Codex",
    description: "Previous generation Codex model",
    tier: "mid",
  },
  "gpt-5.1-codex": {
    name: "GPT-5.1 Codex",
    description: "GPT-5.1 based Codex model",
    tier: "mid",
  },
  "gpt-5.1-codex-max": {
    name: "GPT-5.1 Codex Max",
    description: "Highest capability Codex model with maximum reasoning",
    tier: "high",
  },
  "gpt-5.1-codex-mini": {
    name: "GPT-5.1 Codex Mini",
    description: "Lightweight fast Codex model",
    tier: "fast",
  },
  "gpt-5.2": {
    name: "GPT-5.2",
    description: "General GPT-5.2 model",
    tier: "mid",
  },
  "gpt-5.4": {
    name: "GPT-5.4",
    description: "Latest GPT-5.4 model",
    tier: "high",
  },
};

/**
 * Map from Anthropic model family patterns to Codex models.
 */
const ANTHROPIC_TO_CODEX_MAP: Array<{ pattern: RegExp; codexModel: string }> = [
  { pattern: /opus/i, codexModel: "gpt-5.1-codex-max" },
  { pattern: /sonnet/i, codexModel: "gpt-5.3-codex" },
  { pattern: /haiku/i, codexModel: "gpt-5.1-codex-mini" },
];

/**
 * Runtime proxy configuration — can be updated via POST /claudex/config.
 */
export const proxyConfig = {
  model: process.env.CODEX_MODEL || "",
  reasoning: (process.env.CODEX_REASONING || "") as "" | "low" | "medium" | "high",
};

/**
 * Parse a `claudex:model:reasoning` model string convention.
 * Returns null if the string doesn't match the convention.
 *
 * Examples:
 *   "claudex:gpt-5.3-codex:high" → { model: "gpt-5.3-codex", reasoning: "high" }
 *   "claudex:gpt-5.1-codex-max"  → { model: "gpt-5.1-codex-max", reasoning: undefined }
 */
export function parseClaudexModelString(
  model: string
): { model: string; reasoning?: "low" | "medium" | "high" } | null {
  if (!model.startsWith("claudex:")) return null;
  const parts = model.slice("claudex:".length).split(":");
  if (parts.length === 0 || !parts[0]) return null;
  const result: { model: string; reasoning?: "low" | "medium" | "high" } = {
    model: parts[0],
  };
  if (parts.length >= 2 && ["low", "medium", "high"].includes(parts[1])) {
    result.reasoning = parts[1] as "low" | "medium" | "high";
  }
  return result;
}

/**
 * Map an Anthropic model name to a Codex model name.
 * Priority: claudex: convention > runtime config > env var > pattern match > default.
 */
export function mapModel(anthropicModel: string): string {
  // 1. Check for claudex: convention
  const parsed = parseClaudexModelString(anthropicModel);
  if (parsed) return parsed.model;

  // 2. Check runtime config
  if (proxyConfig.model) return proxyConfig.model;

  // 3. Check env var
  const envModel = process.env.CODEX_MODEL;
  if (envModel) return envModel;

  // 4. Pattern match against Anthropic model families
  for (const { pattern, codexModel } of ANTHROPIC_TO_CODEX_MAP) {
    if (pattern.test(anthropicModel)) return codexModel;
  }

  // 5. Default
  return DEFAULT_CODEX_MODEL;
}

/**
 * Determine reasoning effort for a request.
 * Priority: claudex: convention > Anthropic thinking config > runtime config > env var.
 */
function resolveReasoning(
  req: AnthropicRequest
): CodexReasoning | undefined {
  // 1. Check claudex: convention
  const parsed = parseClaudexModelString(req.model);
  if (parsed?.reasoning) {
    return { effort: parsed.reasoning };
  }

  // 2. Map Anthropic extended thinking to reasoning effort
  if (req.thinking) {
    const budget = req.thinking.budget_tokens as number | undefined;
    if (budget !== undefined) {
      if (budget >= 10000) return { effort: "high" };
      if (budget >= 5000) return { effort: "medium" };
      return { effort: "low" };
    }
    // thinking is enabled but no budget — default to medium
    return { effort: "medium" };
  }

  // 3. Check runtime config
  if (proxyConfig.reasoning) {
    return { effort: proxyConfig.reasoning };
  }

  // 4. Check env var
  const envReasoning = process.env.CODEX_REASONING;
  if (envReasoning && ["low", "medium", "high"].includes(envReasoning)) {
    return { effort: envReasoning as "low" | "medium" | "high" };
  }

  return undefined;
}

// ---------- Request Conversion ----------

/**
 * Convert an Anthropic Messages API request to an OpenAI Responses API request.
 * 将 Anthropic Messages API 请求转换为 OpenAI Responses API 请求。
 *
 * Fields removed (not supported by Codex Responses API):
 *   max_output_tokens, temperature, top_p, stop, metadata, betas, thinking, stream_options
 *
 * Fields added (required or supported by Codex):
 *   tool_choice, parallel_tool_calls, reasoning, include
 */
export function anthropicToCodex(req: AnthropicRequest): OpenAIResponsesRequest {
  const model = mapModel(req.model);

  // Convert system prompt
  let instructions: string | undefined;
  if (typeof req.system === "string") {
    instructions = req.system;
  } else if (Array.isArray(req.system)) {
    instructions = req.system.map((s) => s.text).join("\n");
  }

  // Convert messages
  const input: OpenAIInputMessage[] = convertMessages(req.messages);

  // Convert tools
  let tools: OpenAITool[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  const result: OpenAIResponsesRequest = {
    model,
    input,
    store: false,
    stream: req.stream,
  };

  if (instructions) result.instructions = instructions;
  if (tools) {
    result.tools = tools;
    result.tool_choice = "auto";
    result.parallel_tool_calls = true;
  }

  // Resolve reasoning effort
  const reasoning = resolveReasoning(req);
  if (reasoning) result.reasoning = reasoning;

  return result;
}

function convertMessages(messages: AnthropicMessage[]): OpenAIInputMessage[] {
  const result: OpenAIInputMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Complex content blocks
    const parts: OpenAIContentPart[] = [];
    const toolCalls: OpenAIContentPart[] = [];
    const toolResults: { call_id: string; output: string }[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          parts.push({ type: "input_text", text: block.text });
          break;
        case "image":
          if (block.source.type === "base64" && block.source.data) {
            parts.push({
              type: "input_image",
              image_url: {
                url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}`,
              },
            });
          } else if (block.source.type === "url" && block.source.url) {
            parts.push({
              type: "input_image",
              image_url: { url: block.source.url },
            });
          }
          break;
        case "tool_use":
          toolCalls.push({
            type: "function_call",
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
          break;
        case "tool_result": {
          const output =
            typeof block.content === "string"
              ? block.content
              : (block.content as AnthropicContentBlock[])
                  .filter((c): c is AnthropicTextContent => c.type === "text")
                  .map((c) => c.text)
                  .join("\n");
          toolResults.push({
            call_id: block.tool_use_id,
            output,
          });
          break;
        }
      }
    }

    // Build the messages for OpenAI format
    if (msg.role === "assistant") {
      if (toolCalls.length > 0) {
        // Assistant message with tool calls: add text parts + function calls
        const content: OpenAIContentPart[] = [...parts, ...toolCalls];
        result.push({ role: "assistant", content });
      } else if (parts.length > 0) {
        // Simple text content from assistant
        const textContent = parts
          .filter((p) => p.type === "input_text" && p.text)
          .map((p) => p.text!)
          .join("");
        result.push({ role: "assistant", content: textContent || "" });
      } else {
        result.push({ role: "assistant", content: "" });
      }
    } else {
      // User message
      if (toolResults.length > 0) {
        // Tool results go as separate messages
        for (const tr of toolResults) {
          result.push({
            role: "user",
            content: [
              {
                type: "function_call_output",
                call_id: tr.call_id,
                output: tr.output,
              },
            ],
          });
        }
      }
      if (parts.length > 0) {
        if (parts.length === 1 && parts[0].type === "input_text") {
          result.push({ role: "user", content: parts[0].text || "" });
        } else {
          result.push({ role: "user", content: parts });
        }
      }
      if (parts.length === 0 && toolResults.length === 0) {
        result.push({ role: "user", content: "" });
      }
    }
  }

  return result;
}

// ---------- Response Conversion (Non-Streaming) ----------

/**
 * Convert a Codex/OpenAI Responses API response to Anthropic Messages format.
 * 将 Codex/OpenAI Responses API 响应转换为 Anthropic Messages 格式。
 */
export function codexToAnthropic(
  codexResponse: Record<string, unknown>,
  requestModel: string
): AnthropicResponse {
  const id = generateMsgId();
  const content: AnthropicContentBlock[] = [];
  let stopReason: AnthropicResponse["stop_reason"] = "end_turn";

  const output = codexResponse.output as Array<Record<string, unknown>> | undefined;

  if (output && Array.isArray(output)) {
    for (const item of output) {
      if (item.type === "message") {
        const msgContent = item.content as Array<Record<string, unknown>> | undefined;
        if (msgContent && Array.isArray(msgContent)) {
          for (const part of msgContent) {
            if (part.type === "output_text") {
              content.push({ type: "text", text: String(part.text || "") });
            }
          }
        }
      } else if (item.type === "function_call") {
        content.push({
          type: "tool_use",
          id: String(item.id || item.call_id || generateToolId()),
          name: String(item.name || ""),
          input: parseJsonSafe(String(item.arguments || "{}")),
        });
        stopReason = "tool_use";
      }
    }
  }

  // Fallback: if output is a simple text response (chat completions format)
  if (content.length === 0 && codexResponse.choices) {
    const choices = codexResponse.choices as Array<Record<string, unknown>>;
    if (choices.length > 0) {
      const choice = choices[0];
      const message = choice.message as Record<string, unknown> | undefined;
      if (message) {
        const textContent = message.content;
        if (typeof textContent === "string") {
          content.push({ type: "text", text: textContent });
        }
        const toolCallsRaw = message.tool_calls as Array<Record<string, unknown>> | undefined;
        if (toolCallsRaw) {
          for (const tc of toolCallsRaw) {
            const fn = tc.function as Record<string, unknown>;
            content.push({
              type: "tool_use",
              id: String(tc.id || generateToolId()),
              name: String(fn?.name || ""),
              input: parseJsonSafe(String(fn?.arguments || "{}")),
            });
          }
          stopReason = "tool_use";
        }
        if (choice.finish_reason === "length") stopReason = "max_tokens";
        if (choice.finish_reason === "stop") stopReason = "end_turn";
      }
    }
  }

  // If still no content, add empty text
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const status = codexResponse.status as string | undefined;
  if (status === "incomplete") stopReason = "max_tokens";

  const usage = extractUsage(codexResponse);

  return {
    id,
    type: "message",
    role: "assistant",
    content,
    model: requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

// ---------- Streaming Response Conversion ----------

/**
 * State machine for converting SSE stream from OpenAI Responses API to Anthropic SSE format.
 * 用于将 OpenAI Responses API 的 SSE 流转换为 Anthropic SSE 格式的状态机。
 */
export class StreamConverter {
  private messageId: string;
  private requestModel: string;
  private started = false;
  private completed = false;
  private contentIndex = 0;
  private currentBlockOpen = false;
  private outputTokens = 0;
  private inputTokens = 0;

  constructor(requestModel: string) {
    this.messageId = generateMsgId();
    this.requestModel = requestModel;
  }

  /**
   * Process a single SSE event from Codex and return Anthropic SSE events.
   * 处理来自 Codex 的单个 SSE 事件，返回 Anthropic SSE 事件。
   */
  processEvent(eventType: string, data: Record<string, unknown>): string[] {
    const events: string[] = [];

    if (!this.started) {
      this.started = true;
      events.push(
        this.formatSSE("message_start", {
          type: "message_start",
          message: {
            id: this.messageId,
            type: "message",
            role: "assistant",
            content: [],
            model: this.requestModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })
      );
      events.push(this.formatSSE("ping", { type: "ping" }));
    }

    switch (eventType) {
      case "response.output_text.delta": {
        const delta = String(data.delta || "");
        if (!delta) break;

        if (!this.currentBlockOpen) {
          events.push(
            this.formatSSE("content_block_start", {
              type: "content_block_start",
              index: this.contentIndex,
              content_block: { type: "text", text: "" },
            })
          );
          this.currentBlockOpen = true;
        }

        this.outputTokens += estimateTokens(delta);
        events.push(
          this.formatSSE("content_block_delta", {
            type: "content_block_delta",
            index: this.contentIndex,
            delta: { type: "text_delta", text: delta },
          })
        );
        break;
      }

      case "response.output_text.done": {
        if (this.currentBlockOpen) {
          events.push(
            this.formatSSE("content_block_stop", {
              type: "content_block_stop",
              index: this.contentIndex,
            })
          );
          this.currentBlockOpen = false;
          this.contentIndex++;
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        // Function call streaming — accumulate but don't emit until done
        break;
      }

      case "response.output_item.done": {
        const item = data.item as Record<string, unknown> | undefined;
        if (item && item.type === "function_call") {
          if (this.currentBlockOpen) {
            events.push(
              this.formatSSE("content_block_stop", {
                type: "content_block_stop",
                index: this.contentIndex,
              })
            );
            this.currentBlockOpen = false;
            this.contentIndex++;
          }
          events.push(
            this.formatSSE("content_block_start", {
              type: "content_block_start",
              index: this.contentIndex,
              content_block: {
                type: "tool_use",
                id: String(item.id || item.call_id || generateToolId()),
                name: String(item.name || ""),
                input: {},
              },
            })
          );
          const args = String(item.arguments || "{}");
          events.push(
            this.formatSSE("content_block_delta", {
              type: "content_block_delta",
              index: this.contentIndex,
              delta: {
                type: "input_json_delta",
                partial_json: args,
              },
            })
          );
          events.push(
            this.formatSSE("content_block_stop", {
              type: "content_block_stop",
              index: this.contentIndex,
            })
          );
          this.contentIndex++;
        }
        break;
      }

      case "response.completed": {
        if (this.currentBlockOpen) {
          events.push(
            this.formatSSE("content_block_stop", {
              type: "content_block_stop",
              index: this.contentIndex,
            })
          );
          this.currentBlockOpen = false;
        }

        const response = data.response as Record<string, unknown> | undefined;
        const usageSource = response || data;
        const usage = usageSource.usage as Record<string, unknown> | undefined;
        if (usage) {
          this.inputTokens = Number(usage.input_tokens || 0);
          this.outputTokens = Number(usage.output_tokens || this.outputTokens);
        }

        let stopReason: string = "end_turn";
        const status = (response?.status ?? data.status) as string | undefined;
        if (status === "incomplete") stopReason = "max_tokens";

        const output = (response?.output ?? data.output) as Array<Record<string, unknown>> | undefined;
        if (output?.some((o) => o.type === "function_call")) {
          stopReason = "tool_use";
        }

        events.push(
          this.formatSSE("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: this.outputTokens },
          })
        );
        events.push(
          this.formatSSE("message_stop", { type: "message_stop" })
        );
        this.completed = true;
        break;
      }

      // Events the Codex API emits that we can safely acknowledge but don't need to forward
      case "response.created":
      case "response.output_item.added":
      case "response.reasoning_summary_part.added":
        break;

      // Reasoning events — pass through as text for clients that support it
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        // Reasoning deltas are internal; we don't surface them to Anthropic clients
        break;
      }

      // Error/failure events from the Codex stream
      case "response.failed": {
        const resp = data.response as Record<string, unknown> | undefined;
        const error = resp?.error as Record<string, unknown> | undefined;
        const errorMsg = String(error?.message || "Codex response failed");

        if (this.currentBlockOpen) {
          events.push(
            this.formatSSE("content_block_stop", {
              type: "content_block_stop",
              index: this.contentIndex,
            })
          );
          this.currentBlockOpen = false;
        }

        events.push(
          this.formatSSE("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: this.outputTokens },
          })
        );
        events.push(
          this.formatSSE("error", {
            type: "error",
            error: { type: "api_error", message: errorMsg },
          })
        );
        events.push(
          this.formatSSE("message_stop", { type: "message_stop" })
        );
        this.completed = true;
        break;
      }

      case "response.incomplete": {
        if (this.currentBlockOpen) {
          events.push(
            this.formatSSE("content_block_stop", {
              type: "content_block_stop",
              index: this.contentIndex,
            })
          );
          this.currentBlockOpen = false;
        }

        events.push(
          this.formatSSE("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "max_tokens", stop_sequence: null },
            usage: { output_tokens: this.outputTokens },
          })
        );
        events.push(
          this.formatSSE("message_stop", { type: "message_stop" })
        );
        this.completed = true;
        break;
      }

      // Chat completions streaming format (fallback)
      case "chat.completion.chunk":
      case "": {
        // Handle OpenAI Chat Completions SSE format
        const choices = data.choices as Array<Record<string, unknown>> | undefined;
        if (choices && choices.length > 0) {
          const delta = choices[0].delta as Record<string, unknown> | undefined;
          if (delta) {
            const textContent = delta.content as string | undefined;
            if (textContent) {
              if (!this.currentBlockOpen) {
                events.push(
                  this.formatSSE("content_block_start", {
                    type: "content_block_start",
                    index: this.contentIndex,
                    content_block: { type: "text", text: "" },
                  })
                );
                this.currentBlockOpen = true;
              }
              this.outputTokens += estimateTokens(textContent);
              events.push(
                this.formatSSE("content_block_delta", {
                  type: "content_block_delta",
                  index: this.contentIndex,
                  delta: { type: "text_delta", text: textContent },
                })
              );
            }
          }

          const finishReason = choices[0].finish_reason as string | undefined;
          if (finishReason) {
            if (this.currentBlockOpen) {
              events.push(
                this.formatSSE("content_block_stop", {
                  type: "content_block_stop",
                  index: this.contentIndex,
                })
              );
              this.currentBlockOpen = false;
            }

            let stopReason = "end_turn";
            if (finishReason === "length") stopReason = "max_tokens";
            if (finishReason === "tool_calls") stopReason = "tool_use";

            events.push(
              this.formatSSE("message_delta", {
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: this.outputTokens },
              })
            );
            events.push(
              this.formatSSE("message_stop", { type: "message_stop" })
            );
          }
        }
        break;
      }

      // Ignore other event types
      default:
        break;
    }

    return events;
  }

  /**
   * Generate a final message_stop if the stream ended without a proper completion event.
   */
  finalize(): string[] {
    if (this.completed) return [];
    const events: string[] = [];
    if (this.currentBlockOpen) {
      events.push(
        this.formatSSE("content_block_stop", {
          type: "content_block_stop",
          index: this.contentIndex,
        })
      );
      this.currentBlockOpen = false;
    }
    if (this.started) {
      events.push(
        this.formatSSE("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: this.outputTokens },
        })
      );
      events.push(
        this.formatSSE("message_stop", { type: "message_stop" })
      );
      this.completed = true;
    }
    return events;
  }

  getEstimatedTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  private formatSSE(event: string, data: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

// ---------- Helpers ----------

function generateMsgId(): string {
  return `msg_${crypto.randomBytes(12).toString("hex")}`;
}

function generateToolId(): string {
  return `toolu_${crypto.randomBytes(12).toString("hex")}`;
}

function parseJsonSafe(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

function extractUsage(
  data: Record<string, unknown>
): { input_tokens: number; output_tokens: number } {
  const usage = data.usage as Record<string, unknown> | undefined;
  if (usage) {
    return {
      input_tokens: Number(usage.input_tokens || usage.prompt_tokens || 0),
      output_tokens: Number(
        usage.output_tokens || usage.completion_tokens || 0
      ),
    };
  }
  return { input_tokens: 0, output_tokens: 0 };
}

/**
 * Rough token estimation (~4 chars per token).
 * 粗略的 token 估算（约4个字符一个 token）。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total tokens from an Anthropic request.
 */
export function estimateRequestTokens(req: AnthropicRequest): number {
  let total = 0;
  if (typeof req.system === "string") total += estimateTokens(req.system);
  else if (Array.isArray(req.system))
    total += req.system.reduce((acc, s) => acc + estimateTokens(s.text), 0);

  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else {
      for (const block of msg.content) {
        if (block.type === "text") total += estimateTokens(block.text);
        else if (block.type === "tool_use")
          total += estimateTokens(JSON.stringify(block.input));
        else if (block.type === "tool_result") {
          if (typeof block.content === "string")
            total += estimateTokens(block.content);
        }
      }
    }
  }
  return total;
}

/**
 * Build Anthropic-format error response.
 * 构建 Anthropic 格式的错误响应。
 */
export function buildErrorResponse(
  statusCode: number,
  message: string
): AnthropicErrorResponse {
  let errorType = "api_error";
  if (statusCode === 401) errorType = "authentication_error";
  if (statusCode === 429) errorType = "rate_limit_error";
  if (statusCode === 400) errorType = "invalid_request_error";
  if (statusCode === 404) errorType = "not_found_error";
  if (statusCode === 529 || statusCode === 503) errorType = "overloaded_error";

  return {
    type: "error",
    error: { type: errorType, message },
  };
}
