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

export interface AnthropicJsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, AnthropicJsonSchema>;
  required?: string[];
  additionalProperties?: boolean | AnthropicJsonSchema;
  items?: AnthropicJsonSchema | AnthropicJsonSchema[];
  anyOf?: AnthropicJsonSchema[];
  oneOf?: AnthropicJsonSchema[];
  allOf?: AnthropicJsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  nullable?: boolean;
  title?: string;
  patternProperties?: Record<string, AnthropicJsonSchema>;
  $defs?: Record<string, AnthropicJsonSchema>;
  definitions?: Record<string, AnthropicJsonSchema>;
  dependentSchemas?: Record<string, AnthropicJsonSchema>;
  prefixItems?: AnthropicJsonSchema[];
  not?: AnthropicJsonSchema;
  if?: AnthropicJsonSchema;
  then?: AnthropicJsonSchema;
  else?: AnthropicJsonSchema;
  contains?: AnthropicJsonSchema;
  propertyNames?: AnthropicJsonSchema;
  unevaluatedProperties?: boolean | AnthropicJsonSchema;
  unevaluatedItems?: boolean | AnthropicJsonSchema;
  contentSchema?: AnthropicJsonSchema;
  [key: string]: unknown;
}

export interface AnthropicTool {
  name?: string;
  type?: string;
  description?: string;
  input_schema?: AnthropicJsonSchema;
  [key: string]: unknown;
}

export interface AnthropicToolChoice {
  disable_parallel_tool_use?: boolean;
  [key: string]: unknown;
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
  output_config?: { effort?: string; [key: string]: unknown };
  stream_options?: unknown;
  max_output_tokens?: number;
  tool_choice?: AnthropicToolChoice | string;
  [key: string]: unknown; // catch-all for any other Anthropic-specific fields
}

// ===================================================================
// Codex / OpenAI Responses API types (output to Codex)
// ===================================================================

export interface CodexTool {
  type: "function" | "web_search";
  name?: string;
  description?: string;
  strict?: boolean;
  parameters?: Record<string, unknown>;
}

export interface CodexReasoning {
  effort: "low" | "medium" | "high";
  summary?: "auto" | "concise" | "detailed";
}

export interface CodexInputTextPart {
  type: "input_text";
  text: string;
}

export interface CodexInputImagePart {
  type: "input_image";
  image_url: string;
}

export interface CodexOutputTextPart {
  type: "output_text";
  text: string;
}

export type CodexMessageContent =
  | string
  | Array<CodexInputTextPart | CodexInputImagePart | CodexOutputTextPart>;

export interface CodexInputMessage {
  role: string;
  content: CodexMessageContent;
}

export interface CodexFunctionCallInput {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface CodexFunctionCallOutputInput {
  type: "function_call_output";
  call_id: string;
  output: string | Array<CodexInputTextPart | CodexInputImagePart>;
}

export type CodexInputItem =
  | CodexInputMessage
  | CodexFunctionCallInput
  | CodexFunctionCallOutputInput;

export interface CodexRequest {
  model: string;
  instructions: string;
  input: CodexInputItem[];
  tools?: CodexTool[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  reasoning?: CodexReasoning;
  store: false;
  stream: boolean;
  include: string[];
  service_tier?: string;
  prompt_cache_key?: string;
  text?: Record<string, unknown>;
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
  const outputEffort =
    typeof req.output_config?.effort === "string"
      ? req.output_config.effort.toLowerCase()
      : undefined;

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
    if (
      req.thinking.type === "adaptive" ||
      req.thinking.type === "auto"
    ) {
      if (
        outputEffort === "low" ||
        outputEffort === "medium" ||
        outputEffort === "high"
      ) {
        return {
          effort: outputEffort,
          summary: "auto",
        };
      }
      return { effort: "high", summary: "auto" };
    }
    if (req.thinking.type === "disabled") {
      return { effort: "low", summary: "auto" };
    }
  }

  return { effort: "medium", summary: "auto" };
}

// ===================================================================
// Tool schema conversion
// ===================================================================

/**
 * Whitelist of JSON Schema keywords the Codex API accepts inside tool
 * parameter definitions.  Anything not on this list is silently dropped.
 *
 * Using a whitelist (instead of a blacklist) ensures that *any* new or
 * exotic keyword Claude Code adds will be stripped automatically,
 * preventing the entire class of "Invalid schema" 400 errors.
 */
const ALLOWED_SCHEMA_KEYWORDS = new Set<string>([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "enum",
  "const",
  "default",
  "nullable",
  "title",
]);

const ALLOWED_REQUEST_FIELDS = new Set<string>([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "service_tier",
  "prompt_cache_key",
  "text",
]);

// These schema containers are traversed recursively even if some of them are
// stripped later by the whitelist. This keeps normalization genuinely
// recursive across the full schema tree before unsupported containers are
// removed from the final payload.
const SCHEMA_MAP_KEYWORDS = new Set<string>([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

const SCHEMA_ARRAY_KEYWORDS = new Set<string>([
  "anyOf",
  "oneOf",
  "allOf",
  "prefixItems",
]);

const SCHEMA_KEYWORDS = new Set<string>([
  "additionalProperties",
  "items",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentSchema",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPureRecordContainer(schema: Record<string, unknown>): boolean {
  return (
    schema.type === "object" &&
    !isRecord(schema.properties) &&
    schema.items === undefined &&
    isRecord(schema.additionalProperties)
  );
}

function hasPropertyKeys(schema: Record<string, unknown>): boolean {
  return (
    isRecord(schema.properties) && Object.keys(schema.properties).length > 0
  );
}

function isDegenerateObjectShell(schema: Record<string, unknown>): boolean {
  return (
    schema.type === "object" &&
    !hasPropertyKeys(schema) &&
    schema.items === undefined &&
    !Array.isArray(schema.anyOf) &&
    schema.enum === undefined &&
    schema.const === undefined &&
    !isRecord(schema.additionalProperties)
  );
}

function shouldRequireProperty(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return true;
  }

  // Codex rejects pure record/map container properties in `required`.
  if (isPureRecordContainer(schema)) {
    return false;
  }

  // Codex also rejects object shells that lost their structural shape after
  // unsupported keywords such as `oneOf` / `allOf` were stripped.
  if (isDegenerateObjectShell(schema)) {
    return false;
  }

  return true;
}

function mergeRequiredKeys(
  required: unknown,
  properties: Record<string, unknown>
): string[] {
  const propertyKeys = Object.entries(properties)
    .filter(([, schema]) => shouldRequireProperty(schema))
    .map(([key]) => key);
  const allowed = new Set(propertyKeys);
  const merged: string[] = [];
  if (Array.isArray(required)) {
    for (const entry of required) {
      if (
        typeof entry === "string" &&
        allowed.has(entry) &&
        !merged.includes(entry)
      ) {
        merged.push(entry);
      }
    }
  }
  for (const key of propertyKeys) {
    if (!merged.includes(key)) {
      merged.push(key);
    }
  }
  return merged;
}

interface NormalizeSchemaOptions {
  enforceObjectConstraints: boolean;
}

function normalizeSchemaMap(
  value: unknown,
  options: NormalizeSchemaOptions
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    normalized[key] = normalizeSchemaInternal(child, options);
  }
  return normalized;
}

function filterRequiredKeys(
  required: unknown,
  properties: Record<string, unknown>
): string[] | undefined {
  if (!Array.isArray(required)) {
    return undefined;
  }

  const allowed = new Set(Object.keys(properties));
  const filtered: string[] = [];
  for (const entry of required) {
    if (
      typeof entry === "string" &&
      allowed.has(entry) &&
      !filtered.includes(entry)
    ) {
      filtered.push(entry);
    }
  }

  return filtered.length > 0 ? filtered : undefined;
}

function normalizeNestedSchemaValue(
  key: string,
  value: unknown,
  options: NormalizeSchemaOptions
): unknown {
  if (SCHEMA_MAP_KEYWORDS.has(key)) {
    return normalizeSchemaMap(value, options);
  }

  if (SCHEMA_ARRAY_KEYWORDS.has(key)) {
    return Array.isArray(value)
      ? value.map((item) => normalizeSchemaInternal(item, options))
      : undefined;
  }

  if (SCHEMA_KEYWORDS.has(key)) {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeSchemaInternal(item, options));
    }
    if (typeof value === "boolean") {
      return value;
    }
    return isRecord(value)
      ? normalizeSchemaInternal(value, options)
      : undefined;
  }

  return value;
}

/** Infer the JSON Schema `type` for a schema node when the source omitted it. */
function inferType(normalized: Record<string, unknown>): string {
  if (isRecord(normalized.properties)) {
    return "object";
  }
  if (normalized.items !== undefined) {
    return "array";
  }
  return "object";
}

/**
 * Recursively normalize a JSON Schema node bottom-up:
 *  1. Recurse into nested schema-bearing children.
 *  2. Add a missing `type`.
 *  3. Normalize `required` to the exact set of Codex-counted property keys.
 *  4. Force `additionalProperties: false` on every non-record object node.
 *  5. Drop all non-whitelisted fields, including rejected combinators such
 *     as `oneOf` / `allOf`.
 */
function normalizeSchemaInternal(
  node: unknown,
  options: NormalizeSchemaOptions
): unknown {
  if (node === null || node === undefined || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => normalizeSchemaInternal(item, options));
  }

  const source = node as Record<string, unknown>;
  const normalizedChildren: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(source)) {
    const value = normalizeNestedSchemaValue(key, rawValue, options);
    if (value !== undefined) {
      normalizedChildren[key] = value;
    }
  }

  const withType: Record<string, unknown> =
    normalizedChildren.type === undefined
      ? { ...normalizedChildren, type: inferType(normalizedChildren) }
      : { ...normalizedChildren };

  const normalizedProperties = withType.properties;
  let withRequired = withType;
  if (isRecord(normalizedProperties)) {
    if (options.enforceObjectConstraints) {
      withRequired = {
        ...withType,
        required: mergeRequiredKeys(withType.required, normalizedProperties),
      };
    } else {
      const filteredRequired = filterRequiredKeys(
        withType.required,
        normalizedProperties
      );
      withRequired =
        filteredRequired !== undefined
          ? { ...withType, required: filteredRequired }
          : { ...withType };
    }
  }

  const withAdditionalProperties =
    options.enforceObjectConstraints &&
    withRequired.type === "object" &&
    !isPureRecordContainer(withRequired)
      ? { ...withRequired, additionalProperties: false }
      : withRequired;

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(withAdditionalProperties)) {
    if (!ALLOWED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    if (value !== undefined) {
      normalized[key] = value;
    }
  }

  return normalized;
}

export function normalizeSchema(node: unknown): unknown {
  return normalizeSchemaInternal(node, {
    enforceObjectConstraints: false,
  });
}

/** @deprecated Use normalizeSchema instead. Kept for compatibility with existing callers/tests. */
export const sanitizeToolSchema = normalizeSchema;

function normalizeToolParameters(rawSchema: unknown): Record<string, unknown> {
  const normalized = normalizeSchema(rawSchema);
  const parameters = isRecord(normalized) ? { ...normalized } : {};

  parameters.type = "object";
  if (!isRecord(parameters.properties)) {
    parameters.properties = {};
  }

  return parameters;
}

function normalizeCodexRequestBody(req: CodexRequest): CodexRequest {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req)) {
    if (ALLOWED_REQUEST_FIELDS.has(key) && value !== undefined) {
      normalized[key] = value;
    }
  }
  return normalized as unknown as CodexRequest;
}

const MAX_CODEX_TOOL_NAME_LENGTH = 64;
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const CLAUDE_TOOL_ID_PATTERN = /[^a-zA-Z0-9_-]/g;

function shortenToolNameIfNeeded(name: string): string {
  if (name.length <= MAX_CODEX_TOOL_NAME_LENGTH) {
    return name;
  }

  if (name.startsWith("mcp__")) {
    const lastSeparator = name.lastIndexOf("__");
    if (lastSeparator > 0) {
      const candidate = `mcp__${name.slice(lastSeparator + 2)}`;
      return candidate.slice(0, MAX_CODEX_TOOL_NAME_LENGTH);
    }
  }

  return name.slice(0, MAX_CODEX_TOOL_NAME_LENGTH);
}

function buildToolNameMap(
  tools: AnthropicTool[] | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();

  const makeUnique = (candidate: string): string => {
    if (!used.has(candidate)) {
      return candidate;
    }

    const base = candidate;
    for (let i = 1; ; i += 1) {
      const suffix = `_${i}`;
      const allowedBaseLength = Math.max(
        0,
        MAX_CODEX_TOOL_NAME_LENGTH - suffix.length
      );
      const unique = `${base.slice(0, allowedBaseLength)}${suffix}`;
      if (!used.has(unique)) {
        return unique;
      }
    }
  };

  for (const tool of tools ?? []) {
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      continue;
    }

    const shortened = shortenToolNameIfNeeded(tool.name);
    const unique = makeUnique(shortened);
    used.add(unique);
    map.set(tool.name, unique);
  }

  return map;
}

function restoreOriginalToolName(
  name: string,
  originalTools?: AnthropicTool[]
): string {
  if (!originalTools?.length) {
    return name;
  }

  const reverse = new Map<string, string>();
  for (const [original, shortened] of buildToolNameMap(originalTools)) {
    reverse.set(shortened, original);
  }

  return reverse.get(name) ?? name;
}

function sanitizeToolUseId(id: string | undefined): string {
  const sanitized = (id || "").replace(CLAUDE_TOOL_ID_PATTERN, "_");
  return sanitized || `toolu_${crypto.randomUUID()}`;
}

function extractUsage(
  usage: Record<string, unknown> | undefined
): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
} {
  const rawInput =
    typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens =
    typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
  const inputTokenDetails = isRecord(usage?.input_tokens_details)
    ? usage.input_tokens_details
    : undefined;
  const cachedTokens =
    typeof inputTokenDetails?.cached_tokens === "number"
      ? inputTokenDetails.cached_tokens
      : undefined;
  const cacheReadInputTokens =
    typeof cachedTokens === "number" && cachedTokens > 0
      ? cachedTokens
      : undefined;
  const inputTokens = Math.max(
    0,
    rawInput - (cacheReadInputTokens ?? 0)
  );

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cacheReadInputTokens
      ? { cache_read_input_tokens: cacheReadInputTokens }
      : {}),
  };
}

function extractReasoningText(item: Record<string, unknown>): string {
  const parts: string[] = [];
  const appendText = (value: unknown): void => {
    if (typeof value === "string" && value) {
      parts.push(value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (isRecord(entry) && typeof entry.text === "string" && entry.text) {
          parts.push(entry.text);
        } else if (typeof entry === "string" && entry) {
          parts.push(entry);
        }
      }
    }
  };

  appendText(item.summary);
  if (parts.length === 0) {
    appendText(item.content);
  }

  return parts.join("");
}

/**
 * Convert an Anthropic tool definition to a Codex Responses API tool.
 * The Codex API requires:
 * - flat format: { type: "function", name, description, strict: false, parameters }
 * - top-level parameters must be an object schema
 * - Only whitelisted JSON Schema keywords in parameter schemas
 */
function convertTool(
  tool: AnthropicTool,
  toolNameMap: Map<string, string>
): CodexTool | null {
  if (tool.type === "web_search_20250305") {
    return { type: "web_search" };
  }

  if (typeof tool.name !== "string" || tool.name.length === 0) {
    return null;
  }

  const parameters = normalizeToolParameters(tool.input_schema || {});

  return {
    type: "function",
    name: toolNameMap.get(tool.name) ?? shortenToolNameIfNeeded(tool.name),
    description: tool.description || "",
    strict: false,
    parameters,
  };
}

// ===================================================================
// Message conversion: Anthropic → Codex input items
// ===================================================================

function convertMessages(
  messages: AnthropicMessage[],
  toolNameMap: Map<string, string>
): CodexInputItem[] {
  const result: CodexInputItem[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      if (msg.content.length === 0) {
        continue;
      }

      if (msg.role === "assistant") {
        result.push({
          role: "assistant",
          content: [{ type: "output_text", text: msg.content }],
        });
      } else {
        result.push({ role: msg.role, content: msg.content });
      }
      continue;
    }

    const assistantParts: CodexOutputTextPart[] = [];
    const userParts: Array<CodexInputTextPart | CodexInputImagePart> = [];

    const flushMessage = (): void => {
      if (msg.role === "assistant") {
        if (assistantParts.length === 0) {
          return;
        }
        result.push({
          role: "assistant",
          content: [...assistantParts],
        });
        assistantParts.length = 0;
        return;
      }

      if (userParts.length === 0) {
        return;
      }

      result.push({
        role: "user",
        content: buildOrderedUserMessageContent(userParts),
      });
      userParts.length = 0;
    };

    const appendText = (text: string): void => {
      if (text.length === 0) {
        return;
      }

      if (msg.role === "assistant") {
        assistantParts.push({ type: "output_text", text });
      } else {
        userParts.push({ type: "input_text", text });
      }
    };

    const appendImage = (block: AnthropicImageContent): void => {
      const imagePart = convertImageBlock(block);
      if (msg.role === "user" && imagePart) {
        userParts.push(imagePart);
        return;
      }

      if (block.source.url) {
        appendText(`[Image: ${block.source.url}]`);
      }
    };

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          appendText(block.text);
          break;

        case "tool_use": {
          if (msg.role !== "assistant") {
            break;
          }

          flushMessage();
          const callId = block.id || `call_${crypto.randomUUID()}`;
          result.push({
            type: "function_call",
            call_id: callId,
            name:
              toolNameMap.get(block.name) ?? shortenToolNameIfNeeded(block.name),
            arguments:
              typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input),
          });
          break;
        }

        case "tool_result": {
          if (msg.role !== "user") {
            break;
          }

          flushMessage();
          let output: string | Array<CodexInputTextPart | CodexInputImagePart>;
          if (typeof block.content === "string") {
            output = block.content;
          } else if (Array.isArray(block.content)) {
            const parts: Array<CodexInputTextPart | CodexInputImagePart> = [];
            for (const toolResultBlock of block.content) {
              if (toolResultBlock.type === "text") {
                parts.push({
                  type: "input_text",
                  text: toolResultBlock.text,
                });
              } else if (toolResultBlock.type === "image") {
                const imagePart = convertImageBlock(toolResultBlock);
                if (imagePart) {
                  parts.push(imagePart);
                }
              }
            }
            output = parts.length > 0 ? parts : "";
          } else {
            output = "";
          }
          result.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output,
          });
          break;
        }

        case "image":
          appendImage(block);
          break;
      }
    }

    flushMessage();
  }

  return result;
}

function convertImageBlock(
  block: AnthropicImageContent
): CodexInputImagePart | null {
  if (block.source.type === "url" && block.source.url) {
    return {
      type: "input_image",
      image_url: block.source.url,
    };
  }

  if (block.source.type === "base64" && block.source.data) {
    return {
      type: "input_image",
      image_url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}`,
    };
  }

  return null;
}

function buildOrderedUserMessageContent(
  parts: Array<CodexInputTextPart | CodexInputImagePart>
): CodexMessageContent {
  if (parts.length === 0) {
    return "";
  }

  if (parts.every((part) => part.type === "input_text")) {
    return parts.map((part) => part.text).join("\n");
  }

  return [...parts];
}

function extractSystemTexts(req: AnthropicRequest): string[] {
  if (!req.system) return [];
  if (typeof req.system === "string") {
    return req.system.startsWith(BILLING_HEADER_PREFIX) ? [] : [req.system];
  }
  if (Array.isArray(req.system)) {
    return req.system
      .filter(
        (s) =>
          s.type === "text" &&
          s.text &&
          !s.text.startsWith(BILLING_HEADER_PREFIX)
      )
      .map((s) => s.text);
  }
  return [];
}

function buildDeveloperMessage(
  req: AnthropicRequest
): CodexInputMessage | null {
  const systemTexts = extractSystemTexts(req);
  if (systemTexts.length === 0) {
    return null;
  }

  return {
    role: "developer",
    content: systemTexts.map((text) => ({
      type: "input_text",
      text,
    })),
  };
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
  const toolNameMap = buildToolNameMap(req.tools);
  const input = convertMessages(req.messages, toolNameMap);
  const developerMessage = buildDeveloperMessage(req);
  const reasoning = resolveReasoning(req);
  const parallelToolCalls = !(
    isRecord(req.tool_choice) &&
    req.tool_choice.disable_parallel_tool_use === true
  );

  if (developerMessage) {
    input.unshift(developerMessage);
  }

  const result: CodexRequest = {
    model,
    instructions: "",
    input,
    parallel_tool_calls: parallelToolCalls,
    store: false,
    stream: req.stream === true,
    include: ["reasoning.encrypted_content"],
  };

  if (reasoning) {
    result.reasoning = reasoning;
  }

  // Tools
  if (req.tools && req.tools.length > 0) {
    const convertedTools = req.tools
      .map((tool) => convertTool(tool, toolNameMap))
      .filter((tool): tool is CodexTool => tool !== null);
    if (convertedTools.length > 0) {
      result.tools = convertedTools;
      result.tool_choice = "auto";
    }
  }

  return normalizeCodexRequestBody(result);
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
    | { type: "thinking"; thinking: string }
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
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
  };
}

export function codexToAnthropic(
  codexRes: Record<string, unknown>,
  requestModel: string,
  originalTools?: AnthropicTool[]
): AnthropicResponse {
  // Responses API format: has `output` array
  if (codexRes.output && Array.isArray(codexRes.output)) {
    return convertResponsesFormat(codexRes, requestModel, originalTools);
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
  requestModel: string,
  originalTools?: AnthropicTool[]
): AnthropicResponse {
  const output = codexRes.output as Array<Record<string, unknown>>;
  const content: AnthropicResponse["content"] = [];
  let hasToolUse = false;

  for (const item of output) {
    if (item.type === "reasoning") {
      const thinking = extractReasoningText(item);
      if (thinking) {
        content.push({ type: "thinking", thinking });
      }
    } else if (item.type === "message") {
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
        id: sanitizeToolUseId(
          (item.call_id as string) ||
            (item.id as string) ||
            `toolu_${crypto.randomUUID()}`
        ),
        name: restoreOriginalToolName(
          (item.name as string) || "unknown",
          originalTools
        ),
        input,
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const usage = extractUsage(
    codexRes.usage as Record<string, unknown> | undefined
  );
  const status = codexRes.status as string | undefined;
  const stopReasonFromResponse =
    typeof codexRes.stop_reason === "string" ? codexRes.stop_reason : null;

  let stopReason: AnthropicResponse["stop_reason"] = "end_turn";
  if (hasToolUse) stopReason = "tool_use";
  else if (stopReasonFromResponse === "max_tokens")
    stopReason = "max_tokens";
  else if (stopReasonFromResponse === "stop_sequence")
    stopReason = "stop_sequence";
  else if (status === "incomplete") stopReason = "max_tokens";

  return {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    content,
    model: requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
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
  private originalTools?: AnthropicTool[];
  private started = false;
  private finished = false;
  private blockIndex = 0;
  private openBlockType: "text" | "thinking" | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private outputChars = 0;
  private cacheReadInputTokens = 0;
  private toolCallSeen = false;
  private messageId = `msg_${crypto.randomUUID()}`;
  private pendingToolCall: {
    itemId?: string;
    outputIndex?: number;
    toolId: string;
    name: string;
    argumentsBuffer: string;
    emittedArgumentsDelta: boolean;
  } | null = null;

  constructor(model: string, originalTools?: AnthropicTool[]) {
    this.model = model;
    this.originalTools = originalTools;
  }

  /** Build an Anthropic SSE event string. */
  private sse(eventType: string, data: unknown): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /** Emit message_start + ping on the first event. */
  private ensureStarted(response?: Record<string, unknown>): string[] {
    if (this.started) return [];
    this.started = true;
    const responseId =
      typeof response?.id === "string" ? response.id : this.messageId;
    const responseModel =
      typeof response?.model === "string" ? response.model : this.model;
    return [
      this.sse("message_start", {
        type: "message_start",
        message: {
          id: responseId,
          type: "message",
          role: "assistant",
          content: [],
          model: responseModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      this.sse("ping", { type: "ping" }),
    ];
  }

  private startBlock(type: "text" | "thinking"): string[] {
    const events: string[] = [];
    if (this.openBlockType === type) {
      return events;
    }

    events.push(...this.closeOpenBlock());
    this.openBlockType = type;
    return [
      ...events,
      this.sse("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block:
          type === "thinking"
            ? { type: "thinking", thinking: "" }
            : { type: "text", text: "" },
      }),
    ];
  }

  private closeOpenBlock(expected?: "text" | "thinking"): string[] {
    if (!this.openBlockType) return [];
    if (expected && this.openBlockType !== expected) return [];
    this.openBlockType = null;
    const events = [
      this.sse("content_block_stop", {
        type: "content_block_stop",
        index: this.blockIndex,
      }),
    ];
    this.blockIndex++;
    return events;
  }

  private startToolCall(
    item: Record<string, unknown>,
    emitEmptyDelta: boolean
  ): string[] {
    const rawId =
      (item.call_id as string) ||
      (item.id as string) ||
      `toolu_${crypto.randomUUID()}`;
    const toolId = sanitizeToolUseId(rawId);
    const name = restoreOriginalToolName(
      (item.name as string) || "unknown",
      this.originalTools
    );

    this.pendingToolCall = {
      itemId: typeof item.id === "string" ? item.id : undefined,
      outputIndex:
        typeof item.output_index === "number" ? item.output_index : undefined,
      toolId,
      name,
      argumentsBuffer:
        typeof item.arguments === "string" ? item.arguments : "",
      emittedArgumentsDelta: false,
    };
    this.toolCallSeen = true;

    const events = [
      ...this.closeOpenBlock(),
      this.sse("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: {
          type: "tool_use",
          id: toolId,
          name,
          input: {},
        },
      }),
    ];

    if (emitEmptyDelta) {
      events.push(this.emitToolArgumentDelta(""));
    }

    return events;
  }

  private emitToolArgumentDelta(partialJson: string): string {
    if (this.pendingToolCall) {
      this.pendingToolCall.emittedArgumentsDelta = true;
      this.pendingToolCall.argumentsBuffer += partialJson;
    }

    return this.sse("content_block_delta", {
      type: "content_block_delta",
      index: this.blockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: partialJson,
      },
    });
  }

  private finishToolCall(): string[] {
    if (!this.pendingToolCall) {
      return [];
    }

    this.pendingToolCall = null;
    const events = [
      this.sse("content_block_stop", {
        type: "content_block_stop",
        index: this.blockIndex,
      }),
    ];
    this.blockIndex += 1;
    return events;
  }

  private matchesPendingToolCall(data: Record<string, unknown>): boolean {
    if (!this.pendingToolCall) {
      return false;
    }

    const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
    const outputIndex =
      typeof data.output_index === "number" ? data.output_index : undefined;

    if (
      itemId &&
      this.pendingToolCall.itemId &&
      itemId === this.pendingToolCall.itemId
    ) {
      return true;
    }

    if (
      outputIndex !== undefined &&
      this.pendingToolCall.outputIndex !== undefined &&
      outputIndex === this.pendingToolCall.outputIndex
    ) {
      return true;
    }

    return !itemId && outputIndex === undefined;
  }

  private emitFinish(
    stopReason: string,
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
    }
  ): string[] {
    if (this.finished) return [];
    this.finished = true;

    const usagePayload = usage ?? {
      input_tokens: this.inputTokens,
      output_tokens: Math.max(
        this.outputTokens,
        Math.ceil(this.outputChars / 4)
      ),
      ...(this.cacheReadInputTokens > 0
        ? { cache_read_input_tokens: this.cacheReadInputTokens }
        : {}),
    };

    return [
      this.sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usagePayload,
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
      case "response.created": {
        const response = isRecord(data.response)
          ? (data.response as Record<string, unknown>)
          : undefined;
        events.push(...this.ensureStarted(response));
        break;
      }

      case "response.content_part.added": {
        events.push(...this.ensureStarted());
        const part = isRecord(data.part) ? data.part : undefined;
        if (part?.type === "output_text") {
          events.push(...this.startBlock("text"));
        }
        break;
      }

      case "response.output_text.delta": {
        events.push(...this.ensureStarted());
        events.push(...this.startBlock("text"));
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
        events.push(...this.closeOpenBlock("text"));
        break;

      case "response.content_part.done":
        events.push(...this.ensureStarted());
        events.push(...this.closeOpenBlock("text"));
        break;

      case "response.output_item.added": {
        events.push(...this.ensureStarted());
        const item =
          (data.item as Record<string, unknown>) ?? data;
        if (item.type === "function_call") {
          events.push(...this.startToolCall(item, true));
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        events.push(...this.ensureStarted());
        if (this.pendingToolCall && this.matchesPendingToolCall(data)) {
          const delta =
            typeof data.delta === "string" ? data.delta : "";
          events.push(this.emitToolArgumentDelta(delta));
        }
        break;
      }

      case "response.function_call_arguments.done": {
        events.push(...this.ensureStarted());
        if (this.pendingToolCall && this.matchesPendingToolCall(data)) {
          const argumentsText =
            typeof data.arguments === "string" ? data.arguments : "";
          if (
            !this.pendingToolCall.emittedArgumentsDelta &&
            argumentsText
          ) {
            events.push(this.emitToolArgumentDelta(argumentsText));
          } else if (argumentsText) {
            this.pendingToolCall.argumentsBuffer = argumentsText;
          }
        }
        break;
      }

      case "response.output_item.done": {
        events.push(...this.ensureStarted());
        const item =
          (data.item as Record<string, unknown>) ?? data;
        if (item.type === "function_call") {
          if (!this.pendingToolCall) {
            events.push(...this.startToolCall(item, false));
          }

          if (this.pendingToolCall) {
            const fullArguments =
              typeof item.arguments === "string"
                ? item.arguments
                : this.pendingToolCall.argumentsBuffer;
            if (
              !this.pendingToolCall.emittedArgumentsDelta &&
              fullArguments
            ) {
              events.push(this.emitToolArgumentDelta(fullArguments));
            }
          }

          events.push(...this.finishToolCall());
        }
        break;
      }

      case "response.completed": {
        const response = isRecord(data.response)
          ? (data.response as Record<string, unknown>)
          : undefined;
        events.push(...this.ensureStarted(response));
        events.push(...this.closeOpenBlock());
        if (this.pendingToolCall) {
          if (
            !this.pendingToolCall.emittedArgumentsDelta &&
            this.pendingToolCall.argumentsBuffer
          ) {
            events.push(
              this.emitToolArgumentDelta(this.pendingToolCall.argumentsBuffer)
            );
          }
          events.push(...this.finishToolCall());
        }

        const usage = extractUsage(
          isRecord(response?.usage)
            ? (response.usage as Record<string, unknown>)
            : (data.usage as Record<string, unknown> | undefined)
        );
        this.inputTokens = usage.input_tokens;
        this.outputTokens = usage.output_tokens;
        this.cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;

        // Determine stop reason
        const output = (
          response
            ? response.output
            : data.output
        ) as Array<Record<string, unknown>> | undefined;
        let stopReason = "end_turn";
        const responseStopReason =
          typeof response?.stop_reason === "string"
            ? response.stop_reason
            : undefined;
        if (
          this.toolCallSeen ||
          output?.some((item) => item.type === "function_call")
        ) {
          stopReason = "tool_use";
        } else if (responseStopReason === "max_tokens") {
          stopReason = "max_tokens";
        } else if (responseStopReason === "stop_sequence") {
          stopReason = "stop_sequence";
        }

        events.push(...this.emitFinish(stopReason, usage));
        break;
      }

      case "response.failed": {
        events.push(...this.ensureStarted());
        events.push(...this.closeOpenBlock());

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
        events.push(...this.closeOpenBlock());
        events.push(...this.emitFinish("max_tokens"));
        break;
      }

      // Reasoning events — silently consume (no Anthropic equivalent)
      case "response.reasoning_summary_part.added":
        events.push(...this.ensureStarted());
        events.push(...this.startBlock("thinking"));
        break;

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        events.push(...this.ensureStarted());
        events.push(...this.startBlock("thinking"));
        if (typeof data.delta === "string" && data.delta) {
          events.push(
            this.sse("content_block_delta", {
              type: "content_block_delta",
              index: this.blockIndex,
              delta: {
                type: "thinking_delta",
                thinking: data.delta,
              },
            })
          );
        }
        break;

      case "response.reasoning_summary_part.done":
        events.push(...this.ensureStarted());
        events.push(...this.closeOpenBlock("thinking"));
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
        events.push(...this.startBlock("text"));
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
        events.push(...this.closeOpenBlock("text"));
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
    events.push(...this.closeOpenBlock());
    if (this.pendingToolCall) {
      if (
        !this.pendingToolCall.emittedArgumentsDelta &&
        this.pendingToolCall.argumentsBuffer
      ) {
        events.push(
          this.emitToolArgumentDelta(this.pendingToolCall.argumentsBuffer)
        );
      }
      events.push(...this.finishToolCall());
    }
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
  for (const text of extractSystemTexts(req)) {
    total += estimateTokens(text);
  }
  for (const msg of req.messages) {
    total += estimateTokens(msg.role);
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") total += estimateTokens(block.text);
        else if (block.type === "image") {
          total += estimateTokens(block.source.media_type || "");
          total += estimateTokens(block.source.url || "");
          total += estimateTokens(block.source.data || "");
        } else if (block.type === "tool_use") {
          total += estimateTokens(block.id);
          total += estimateTokens(block.name);
          total += estimateTokens(JSON.stringify(block.input));
        } else if (block.type === "tool_result") {
          total += estimateTokens(block.tool_use_id);
          if (typeof block.content === "string")
            total += estimateTokens(block.content);
          else if (Array.isArray(block.content)) {
            for (const part of block.content) {
              if (part.type === "text") {
                total += estimateTokens(part.text);
              } else if (part.type === "image") {
                total += estimateTokens(part.source.media_type || "");
                total += estimateTokens(part.source.url || "");
                total += estimateTokens(part.source.data || "");
              }
            }
          }
        }
      }
    }
  }
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      total += estimateTokens(tool.type || "");
      total += estimateTokens(tool.name || "");
      total += estimateTokens(tool.description || "");
      if (tool.input_schema) {
        total += estimateTokens(JSON.stringify(tool.input_schema));
      }
    }
  }
  if (req.tool_choice) {
    total += estimateTokens(
      typeof req.tool_choice === "string"
        ? req.tool_choice
        : JSON.stringify(req.tool_choice)
    );
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
