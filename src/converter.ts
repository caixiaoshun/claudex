/**
 * Format converter — bidirectional Anthropic Messages API ↔ OpenAI Responses API.
 *
 * Ground truth references:
 *   - sst/opencode  packages/opencode/src/plugin/codex.ts
 *   - openai/codex  codex-rs/codex-api/src/common.rs  (ResponsesApiRequest)
 *   - openai/codex  codex-rs/core/src/client_common.rs (ResponsesApiTool)
 *   - openai/codex  codex-rs/codex-api/src/sse/responses.rs (SSE events)
 */

import * as crypto from "node:crypto";
import {
  getModels,
  getDefaultModel,
  mapModelByTier,
} from "./models.js";

// ===================================================================
// Runtime config (model / reasoning overrides)
// ===================================================================

export const proxyConfig = {
  model: process.env.CODEX_MODEL || "",
  reasoning: (process.env.CODEX_REASONING || "") as
    | ""
    | "low"
    | "medium"
    | "high",
};

// ===================================================================
// Anthropic types (input from Claude Code)
// ===================================================================

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
  input_schema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
  };
}

export interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  messages: AnthropicMessage[];
  system?:
    | string
    | Array<{ type: string; text: string; [key: string]: unknown }>;
  tools?: AnthropicTool[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  // Fields Claude Code may send that must be stripped
  betas?: unknown;
  metadata?: unknown;
  thinking?: { type?: string; budget_tokens?: number; [key: string]: unknown };
  stream_options?: unknown;
  max_output_tokens?: number;
  [key: string]: unknown; // catch-all for any other Anthropic-specific fields
}

// ===================================================================
// Codex / OpenAI Responses API types (output to Codex)
// ===================================================================

export interface CodexTool {
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

export interface CodexReasoning {
  effort: "low" | "medium" | "high";
  summary?: "auto" | "concise" | "detailed";
}

export interface CodexInputMessage {
  role: string;
  content: unknown;
}

export interface CodexRequest {
  model: string;
  instructions: string;
  input: CodexInputMessage[];
  tools?: CodexTool[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  reasoning?: CodexReasoning;
  store: false;
  stream: boolean;
  include: string[];
}

// ===================================================================
// Model mapping
// ===================================================================

/** Parse a "claudex:<model>:<reasoning>" string sent via Claude Code /model. */
export function parseClaudexModelString(
  model: string
): { model: string; reasoning?: string } | null {
  if (!model.startsWith("claudex:")) return null;
  const parts = model.split(":");
  if (parts.length < 2 || !parts[1]) return null;
  return {
    model: parts[1],
    reasoning: parts[2] || undefined,
  };
}

/** Resolve the Codex model to use for a given Anthropic model string. */
export function mapModel(anthropicModel: string): string {
  // 1. claudex: convention
  const parsed = parseClaudexModelString(anthropicModel);
  if (parsed) return parsed.model;

  // 2. CLI / env override
  if (proxyConfig.model) return proxyConfig.model;
  const envModel = process.env.CODEX_MODEL;
  if (envModel) return envModel;

  // 3. If the model is already a known Codex model, pass through
  const knownModels = getModels();
  if (knownModels[anthropicModel]) return anthropicModel;

  // 4. Map Anthropic tier → Codex model
  const mapped = mapModelByTier(anthropicModel);
  if (mapped) return mapped;

  // 5. Default
  return getDefaultModel();
}

/** Resolve reasoning effort from request / config / claudex convention. */
function resolveReasoning(
  req: AnthropicRequest
): CodexReasoning | undefined {
  // From claudex:<model>:<reasoning> convention
  const parsed = parseClaudexModelString(req.model);
  if (parsed?.reasoning) {
    const effort = parsed.reasoning as "low" | "medium" | "high";
    if (["low", "medium", "high"].includes(effort)) {
      return { effort, summary: "auto" };
    }
  }

  // From CLI / env
  if (proxyConfig.reasoning) {
    return { effort: proxyConfig.reasoning, summary: "auto" };
  }

  // From Anthropic thinking config
  if (req.thinking && typeof req.thinking === "object") {
    const budget = req.thinking.budget_tokens;
    if (typeof budget === "number") {
      const effort: "low" | "medium" | "high" =
        budget >= 10000 ? "high" : budget >= 3000 ? "medium" : "low";
      return { effort, summary: "auto" };
    }
    if (req.thinking.type === "enabled") {
      return { effort: "medium", summary: "auto" };
    }
  }

  return undefined;
}

// ===================================================================
// Tool schema conversion
// ===================================================================

/**
 * Convert an Anthropic tool definition to a Codex Responses API tool.
 * The Codex API requires:
 * - flat format: { type: "function", name, description, strict: true, parameters }
 * - `required` must include EVERY key in `properties`
 * - `additionalProperties` must be false
 * - `strict` must be true
 */
function convertTool(tool: AnthropicTool): CodexTool {
  const schema = tool.input_schema || {};
  const properties = (schema.properties as Record<string, unknown>) || {};
  // Always enforce: required = all keys from properties
  const allKeys = Object.keys(properties);

  return {
    type: "function",
    name: tool.name,
    description: tool.description || "",
    strict: true,
    parameters: {
      type: "object",
      properties,
      required: allKeys,
      additionalProperties: false,
    },
  };
}

// ===================================================================
// Message conversion: Anthropic → Codex input items
// ===================================================================

function convertMessages(
  messages: AnthropicMessage[]
): CodexInputMessage[] {
  const result: CodexInputMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Array content blocks
    const blocks = msg.content;
    const textParts: string[] = [];
    const functionCalls: Array<{
      type: "function_call";
      id: string;
      call_id: string;
      name: string;
      arguments: string;
    }> = [];
    const functionOutputs: Array<{
      type: "function_call_output";
      call_id: string;
      output: string;
    }> = [];

    for (const block of blocks) {
      switch (block.type) {
        case "text":
          textParts.push(block.text);
          break;

        case "tool_use": {
          const callId = block.id || `call_${crypto.randomUUID()}`;
          functionCalls.push({
            type: "function_call",
            id: callId,
            call_id: callId,
            name: block.name,
            arguments:
              typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input),
          });
          break;
        }

        case "tool_result": {
          let output: string;
          if (typeof block.content === "string") {
            output = block.content;
          } else if (Array.isArray(block.content)) {
            output = block.content
              .filter(
                (b): b is AnthropicTextContent => b.type === "text"
              )
              .map((b) => b.text)
              .join("\n");
          } else {
            output = "";
          }
          functionOutputs.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output,
          });
          break;
        }

        case "image":
          // Pass image URLs when possible, skip base64 (Codex doesn't support inline base64)
          if (block.source.url) {
            textParts.push(`[Image: ${block.source.url}]`);
          }
          break;
      }
    }

    // Emit assistant messages
    if (msg.role === "assistant") {
      if (textParts.length > 0 && functionCalls.length > 0) {
        // Mixed text + function calls: emit as array of content items
        const content: unknown[] = [];
        if (textParts.length > 0) {
          content.push({
            type: "output_text",
            text: textParts.join("\n"),
          });
        }
        for (const fc of functionCalls) {
          content.push(fc);
        }
        result.push({ role: "assistant", content });
      } else if (functionCalls.length > 0) {
        // Only function calls
        const content = functionCalls.map((fc) => fc);
        result.push({ role: "assistant", content });
      } else {
        result.push({
          role: "assistant",
          content: textParts.join("\n"),
        });
      }
    }

    // Emit user messages
    if (msg.role === "user") {
      if (functionOutputs.length > 0) {
        // Tool results go as separate items
        for (const fo of functionOutputs) {
          result.push({ role: "user", content: fo });
        }
        // Any remaining text
        if (textParts.length > 0) {
          result.push({
            role: "user",
            content: textParts.join("\n"),
          });
        }
      } else {
        result.push({
          role: "user",
          content: textParts.length > 0 ? textParts.join("\n") : "",
        });
      }
    }
  }

  return result;
}

/** Extract system prompt/instructions from Anthropic request. */
function extractInstructions(req: AnthropicRequest): string {
  if (!req.system) return "";
  if (typeof req.system === "string") return req.system;
  if (Array.isArray(req.system)) {
    return req.system
      .filter((s) => s.type === "text" && s.text)
      .map((s) => s.text)
      .join("\n");
  }
  return "";
}

// ===================================================================
// Main conversion: Anthropic request → Codex request
// ===================================================================

/**
 * Convert an Anthropic Messages API request to a Codex Responses API request.
 * Only whitelisted fields are forwarded — everything else is stripped.
 */
export function anthropicToCodex(req: AnthropicRequest): CodexRequest {
  const model = mapModel(req.model);
  const instructions = extractInstructions(req);
  const input = convertMessages(req.messages);
  const reasoning = resolveReasoning(req);

  const result: CodexRequest = {
    model,
    instructions,
    input,
    store: false,
    stream: req.stream === true,
    include: [],
  };

  if (reasoning) {
    result.reasoning = reasoning;
  }

  // Tools
  if (req.tools && req.tools.length > 0) {
    result.tools = req.tools.map(convertTool);
    result.tool_choice = "auto";
    result.parallel_tool_calls = true;
  }

  return result;
}

// ===================================================================
// Codex response → Anthropic response (non-streaming)
// ===================================================================

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }
  >;
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export function codexToAnthropic(
  codexRes: Record<string, unknown>,
  requestModel: string
): AnthropicResponse {
  // Responses API format: has `output` array
  if (codexRes.output && Array.isArray(codexRes.output)) {
    return convertResponsesFormat(codexRes, requestModel);
  }

  // Chat Completions fallback: has `choices` array
  if (codexRes.choices && Array.isArray(codexRes.choices)) {
    return convertChatCompletionsFormat(codexRes, requestModel);
  }

  // Unknown format — return empty
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "" }],
    model: requestModel,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function convertResponsesFormat(
  codexRes: Record<string, unknown>,
  requestModel: string
): AnthropicResponse {
  const output = codexRes.output as Array<Record<string, unknown>>;
  const content: AnthropicResponse["content"] = [];
  let hasToolUse = false;

  for (const item of output) {
    if (item.type === "message") {
      const msgContent = item.content as
        | Array<Record<string, unknown>>
        | undefined;
      if (msgContent) {
        for (const c of msgContent) {
          if (c.type === "output_text" && typeof c.text === "string") {
            content.push({ type: "text", text: c.text });
          }
        }
      }
    } else if (item.type === "function_call") {
      hasToolUse = true;
      let input: Record<string, unknown> = {};
      try {
        input =
          typeof item.arguments === "string"
            ? JSON.parse(item.arguments as string)
            : (item.arguments as Record<string, unknown>) || {};
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id:
          (item.call_id as string) ||
          (item.id as string) ||
          `toolu_${crypto.randomUUID()}`,
        name: (item.name as string) || "unknown",
        input,
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const usage = codexRes.usage as Record<string, number> | undefined;
  const status = codexRes.status as string | undefined;

  let stopReason: AnthropicResponse["stop_reason"] = "end_turn";
  if (hasToolUse) stopReason = "tool_use";
  else if (status === "incomplete") stopReason = "max_tokens";

  return {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    content,
    model: requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    },
  };
}

function convertChatCompletionsFormat(
  codexRes: Record<string, unknown>,
  requestModel: string
): AnthropicResponse {
  const choices = codexRes.choices as Array<Record<string, unknown>>;
  const content: AnthropicResponse["content"] = [];

  if (choices.length > 0) {
    const choice = choices[0];
    const message = choice.message as Record<string, unknown> | undefined;
    if (message?.content && typeof message.content === "string") {
      content.push({ type: "text", text: message.content });
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const usage = codexRes.usage as Record<string, number> | undefined;

  return {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    content,
    model: requestModel,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
    },
  };
}

// ===================================================================
// Streaming: Codex SSE → Anthropic SSE
// ===================================================================

/**
 * StreamConverter — stateful converter that transforms Codex SSE events
 * into Anthropic SSE events.
 *
 * Handled Codex SSE event types (from openai/codex sse/responses.rs):
 *   response.created
 *   response.output_text.delta
 *   response.output_text.done
 *   response.output_item.added
 *   response.output_item.done
 *   response.completed
 *   response.failed
 *   response.incomplete
 *   response.reasoning_summary_text.delta
 *   response.reasoning_text.delta
 *   response.reasoning_summary_part.added
 */
export class StreamConverter {
  private model: string;
  private started = false;
  private finished = false;
  private blockIndex = 0;
  private blockOpen = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private outputChars = 0;

  constructor(model: string) {
    this.model = model;
  }

  /** Build an Anthropic SSE event string. */
  private sse(eventType: string, data: unknown): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /** Emit message_start + ping on the first event. */
  private ensureStarted(): string[] {
    if (this.started) return [];
    this.started = true;
    return [
      this.sse("message_start", {
        type: "message_start",
        message: {
          id: `msg_${crypto.randomUUID()}`,
          type: "message",
          role: "assistant",
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      this.sse("ping", { type: "ping" }),
    ];
  }

  private ensureBlockOpen(): string[] {
    if (this.blockOpen) return [];
    this.blockOpen = true;
    return [
      this.sse("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "text", text: "" },
      }),
    ];
  }

  private closeBlock(): string[] {
    if (!this.blockOpen) return [];
    this.blockOpen = false;
    const events = [
      this.sse("content_block_stop", {
        type: "content_block_stop",
        index: this.blockIndex,
      }),
    ];
    this.blockIndex++;
    return events;
  }

  private emitFinish(
    stopReason: string,
    inputTokens?: number,
    outputTokens?: number
  ): string[] {
    if (this.finished) return [];
    this.finished = true;

    const iTokens = inputTokens ?? this.inputTokens;
    const oTokens =
      outputTokens ?? Math.max(this.outputTokens, Math.ceil(this.outputChars / 4));

    return [
      this.sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: oTokens },
      }),
      this.sse("message_stop", { type: "message_stop" }),
    ];
  }

  /**
   * Process a single Codex SSE event and return Anthropic SSE events.
   */
  processEvent(
    eventType: string,
    data: Record<string, unknown>
  ): string[] {
    const events: string[] = [];

    // Chat Completions streaming fallback
    if (
      !eventType &&
      data.choices &&
      Array.isArray(data.choices)
    ) {
      return this.handleChatCompletionsChunk(data);
    }

    switch (eventType) {
      case "response.created":
        events.push(...this.ensureStarted());
        break;

      case "response.output_text.delta": {
        events.push(...this.ensureStarted());
        events.push(...this.ensureBlockOpen());
        const delta =
          typeof data.delta === "string" ? data.delta : "";
        if (delta) {
          this.outputChars += delta.length;
          events.push(
            this.sse("content_block_delta", {
              type: "content_block_delta",
              index: this.blockIndex,
              delta: { type: "text_delta", text: delta },
            })
          );
        }
        break;
      }

      case "response.output_text.done":
        events.push(...this.ensureStarted());
        events.push(...this.closeBlock());
        break;

      case "response.output_item.added":
        events.push(...this.ensureStarted());
        break;

      case "response.output_item.done": {
        events.push(...this.ensureStarted());
        const item =
          (data.item as Record<string, unknown>) ?? data;
        if (item.type === "function_call") {
          // Close any open text block first
          events.push(...this.closeBlock());

          let input: Record<string, unknown> = {};
          try {
            input =
              typeof item.arguments === "string"
                ? JSON.parse(item.arguments as string)
                : (item.arguments as Record<string, unknown>) || {};
          } catch {
            input = {};
          }

          const toolId =
            (item.call_id as string) ||
            (item.id as string) ||
            `toolu_${crypto.randomUUID()}`;

          events.push(
            this.sse("content_block_start", {
              type: "content_block_start",
              index: this.blockIndex,
              content_block: {
                type: "tool_use",
                id: toolId,
                name: (item.name as string) || "unknown",
                input,
              },
            })
          );
          events.push(
            this.sse("content_block_delta", {
              type: "content_block_delta",
              index: this.blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(input),
              },
            })
          );
          events.push(
            this.sse("content_block_stop", {
              type: "content_block_stop",
              index: this.blockIndex,
            })
          );
          this.blockIndex++;
        }
        break;
      }

      case "response.completed": {
        events.push(...this.ensureStarted());
        events.push(...this.closeBlock());

        let iTokens = 0;
        let oTokens = 0;
        const usage = (
          data.response
            ? (data.response as Record<string, unknown>).usage
            : data.usage
        ) as Record<string, number> | undefined;
        if (usage) {
          iTokens = usage.input_tokens ?? 0;
          oTokens = usage.output_tokens ?? 0;
          this.inputTokens = iTokens;
          this.outputTokens = oTokens;
        }

        // Determine stop reason
        const output = (
          data.response
            ? (data.response as Record<string, unknown>).output
            : data.output
        ) as Array<Record<string, unknown>> | undefined;
        let stopReason = "end_turn";
        if (output) {
          const hasToolUse = output.some(
            (o) => o.type === "function_call"
          );
          if (hasToolUse) stopReason = "tool_use";
        }

        events.push(...this.emitFinish(stopReason, iTokens, oTokens));
        break;
      }

      case "response.failed": {
        events.push(...this.ensureStarted());
        events.push(...this.closeBlock());

        let errorMsg = "Unknown error";
        const resp = data.response as
          | Record<string, unknown>
          | undefined;
        if (resp?.error) {
          const err = resp.error as Record<string, unknown>;
          errorMsg = (err.message as string) || "Unknown error";
        }

        events.push(
          this.sse("error", {
            type: "error",
            error: {
              type: "api_error",
              message: errorMsg,
            },
          })
        );
        events.push(...this.emitFinish("end_turn"));
        break;
      }

      case "response.incomplete": {
        events.push(...this.ensureStarted());
        events.push(...this.closeBlock());
        events.push(...this.emitFinish("max_tokens"));
        break;
      }

      // Reasoning events — silently consume (no Anthropic equivalent)
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_part.added":
        events.push(...this.ensureStarted());
        break;

      default:
        // Unknown events are silently ignored
        events.push(...this.ensureStarted());
        break;
    }

    return events;
  }

  /** Handle Chat Completions streaming chunks as fallback. */
  private handleChatCompletionsChunk(
    data: Record<string, unknown>
  ): string[] {
    const events: string[] = [];
    events.push(...this.ensureStarted());

    const choices = data.choices as Array<Record<string, unknown>>;
    if (choices.length > 0) {
      const choice = choices[0];
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (delta?.content && typeof delta.content === "string") {
        events.push(...this.ensureBlockOpen());
        this.outputChars += delta.content.length;
        events.push(
          this.sse("content_block_delta", {
            type: "content_block_delta",
            index: this.blockIndex,
            delta: { type: "text_delta", text: delta.content },
          })
        );
      }

      if (choice.finish_reason === "stop") {
        events.push(...this.closeBlock());
        events.push(...this.emitFinish("end_turn"));
      }
    }

    return events;
  }

  /** Finalize the stream if no completion event was received. */
  finalize(): string[] {
    if (this.finished) return [];
    const events: string[] = [];
    events.push(...this.ensureStarted());
    events.push(...this.closeBlock());
    events.push(...this.emitFinish("end_turn"));
    return events;
  }

  /** Estimated output token count. */
  getEstimatedTokens(): number {
    return Math.max(
      this.inputTokens + this.outputTokens,
      Math.ceil(this.outputChars / 4)
    );
  }
}

// ===================================================================
// Utility helpers
// ===================================================================

/** Rough token estimate for a string (~4 chars per token). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Estimate total tokens in an Anthropic request. */
export function estimateRequestTokens(req: AnthropicRequest): number {
  let total = 0;
  if (typeof req.system === "string") {
    total += estimateTokens(req.system);
  } else if (Array.isArray(req.system)) {
    for (const s of req.system) total += estimateTokens(s.text || "");
  }
  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
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

/** Build an Anthropic-format error response. */
export function buildErrorResponse(
  status: number,
  message: string
): {
  type: "error";
  error: { type: string; message: string };
} {
  const typeMap: Record<number, string> = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    429: "rate_limit_error",
    500: "api_error",
    502: "api_error",
    503: "overloaded_error",
  };
  return {
    type: "error",
    error: {
      type: typeMap[status] || "api_error",
      message,
    },
  };
}

/** Expose known Codex model list (re-export for backward compat). */
export const CODEX_MODELS = getModels;
