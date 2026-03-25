/**
 * Unit tests for format converter
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  anthropicToCodex,
  codexToAnthropic,
  buildErrorResponse,
  estimateTokens,
  estimateRequestTokens,
  StreamConverter,
  parseClaudexModelString,
  mapModel,
  proxyConfig,
  CODEX_MODELS,
  sanitizeToolSchema,
  type AnthropicRequest,
} from "../src/converter.js";
import { _resetForTesting, getModels } from "../src/models.js";

function asCodexMessage(item: unknown): { role: string; content: unknown } {
  return item as { role: string; content: unknown };
}

function asFunctionTool(
  tool: NonNullable<ReturnType<typeof anthropicToCodex>["tools"]>[number]
): {
  type: "function";
  name: string;
  description?: string;
  strict?: boolean;
  parameters: Record<string, unknown>;
} {
  assert.equal(tool.type, "function");
  assert.ok(tool.name);
  assert.ok(tool.parameters);
  return tool as {
    type: "function";
    name: string;
    description?: string;
    strict?: boolean;
    parameters: Record<string, unknown>;
  };
}

describe("anthropicToCodex", () => {
  it("should convert a simple text request", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello, world!" }],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.model, "gpt-5.4-mini");
    // max_output_tokens must NOT be sent (causes 400 from Codex API)
    assert.equal(
      (result as unknown as Record<string, unknown>).max_output_tokens,
      undefined
    );
    assert.equal(result.input.length, 1);
    const message = asCodexMessage(result.input[0]);
    assert.equal(message.role, "user");
    assert.equal(message.content, "Hello, world!");
  });

  it("should convert system prompt to a developer message", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: "You are a helpful coding assistant.",
      messages: [{ role: "user", content: "Help me" }],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.instructions, "");
    assert.equal(result.input.length, 2);
    assert.deepEqual(result.input[0], {
      role: "developer",
      content: [
        {
          type: "input_text",
          text: "You are a helpful coding assistant.",
        },
      ],
    });
    assert.deepEqual(result.input[1], {
      role: "user",
      content: "Help me",
    });
  });

  it("should convert array system prompt into developer content parts", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: [
        { type: "text", text: "You are helpful." },
        { type: "text", text: "Be concise." },
      ],
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.instructions, "");
    assert.equal(result.input.length, 2);
    assert.deepEqual(result.input[0], {
      role: "developer",
      content: [
        { type: "input_text", text: "You are helpful." },
        { type: "input_text", text: "Be concise." },
      ],
    });
    assert.deepEqual(result.input[1], {
      role: "user",
      content: "Hello",
    });
  });

  it("should skip empty system prompts instead of emitting a blank developer message", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: "",
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.instructions, "");
    assert.equal(result.input.length, 1);
    assert.deepEqual(result.input[0], {
      role: "user",
      content: "Hello",
    });
  });

  it("should convert multi-turn conversation", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.input.length, 3);
    const first = asCodexMessage(result.input[0]);
    const second = asCodexMessage(result.input[1]);
    const third = asCodexMessage(result.input[2]);
    assert.equal(first.content, "Hello");
    assert.equal(second.role, "assistant");
    assert.deepEqual(second.content, [
      { type: "output_text", text: "Hi there!" },
    ]);
    assert.equal(third.content, "How are you?");
  });

  it("should preserve user image URLs as input_image parts", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this screenshot." },
            {
              type: "image",
              source: {
                type: "url",
                url: "https://example.com/screenshot.png",
              },
            },
          ],
        },
      ],
    };

    const result = anthropicToCodex(req);
    const message = asCodexMessage(result.input[0]);

    assert.deepEqual(message.content, [
      { type: "input_text", text: "Describe this screenshot." },
      {
        type: "input_image",
        image_url: "https://example.com/screenshot.png",
      },
    ]);
  });

  it("should convert base64 user images into data URLs", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "/9j/4AAQSkZJRgABAQAAAQABAAD",
              },
            },
          ],
        },
      ],
    };

    const result = anthropicToCodex(req);
    const message = asCodexMessage(result.input[0]);

    assert.deepEqual(message.content, [
      { type: "input_text", text: "What is in this image?" },
      {
        type: "input_image",
        image_url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD",
      },
    ]);
  });

  it("should convert tools to OpenAI format with Claude-compatible tool strictness", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          name: "get_weather",
          description: "Get current weather",
          input_schema: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      ],
    };

    const result = anthropicToCodex(req);
    const tool = asFunctionTool(result.tools![0]);

    assert.ok(result.tools);
    assert.equal(result.tools!.length, 1);
    assert.equal(tool.type, "function");
    assert.equal(tool.name, "get_weather");
    assert.equal(tool.description, "Get current weather");
    assert.equal(tool.strict, false);
    assert.deepEqual(tool.parameters.required, ["location"]);
  });

  it("should preserve declared required keys without forcing optional tool parameters", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          name: "multi_param",
          description: "Tool with multiple params",
          input_schema: {
            type: "object",
            properties: {
              a: { type: "string" },
              b: { type: "number" },
              c: { type: "boolean" },
            },
            // Claude Code only lists "a" as required
            required: ["a"],
          },
        },
      ],
    };

    const result = anthropicToCodex(req);
    const tool = asFunctionTool(result.tools![0]);

    const required = tool.parameters.required as string[];
    assert.ok(required.includes("a"));
    assert.ok(!required.includes("b"));
    assert.ok(!required.includes("c"));
    assert.equal(required.length, 1);
  });

  it("should convert stream flag", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    };

    const result = anthropicToCodex(req);

    assert.equal(result.stream, true);
  });

  it("should always set store to false", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.store, false);
  });

  it("should strip temperature, top_p, and stop_sequences (not supported by Codex)", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ["END", "STOP"],
    };

    const result = anthropicToCodex(req);

    // These fields must not be forwarded to Codex
    assert.equal(
      (result as unknown as Record<string, unknown>).temperature,
      undefined
    );
    assert.equal(
      (result as unknown as Record<string, unknown>).top_p,
      undefined
    );
    assert.equal(
      (result as unknown as Record<string, unknown>).stop,
      undefined
    );
  });

  it("should convert tool_use content blocks", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check the weather." },
            {
              type: "tool_use",
              id: "toolu_123",
              name: "get_weather",
              input: { location: "Tokyo" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: "Sunny, 25°C",
            },
          ],
        },
      ],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.input.length, 3);
    assert.deepEqual(result.input[0], {
      role: "assistant",
      content: [{ type: "output_text", text: "Let me check the weather." }],
    });
    assert.deepEqual(result.input[1], {
      type: "function_call",
      call_id: "toolu_123",
      name: "get_weather",
      arguments: JSON.stringify({ location: "Tokyo" }),
    });
    assert.deepEqual(result.input[2], {
      type: "function_call_output",
      call_id: "toolu_123",
      output: "Sunny, 25°C",
    });
  });

  it("should preserve assistant and user content order around tool turns", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Before tool" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_weather",
              input: { location: "Tokyo" },
            },
            { type: "text", text: "After tool" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Before result" },
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "Sunny",
            },
            { type: "text", text: "After result" },
          ],
        },
      ],
    };

    const result = anthropicToCodex(req);

    assert.deepEqual(result.input, [
      {
        role: "assistant",
        content: [{ type: "output_text", text: "Before tool" }],
      },
      {
        type: "function_call",
        call_id: "toolu_1",
        name: "get_weather",
        arguments: "{\"location\":\"Tokyo\"}",
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "After tool" }],
      },
      {
        role: "user",
        content: "Before result",
      },
      {
        type: "function_call_output",
        call_id: "toolu_1",
        output: "Sunny",
      },
      {
        role: "user",
        content: "After result",
      },
    ]);
  });

  it("should set tool_choice and parallel_tool_calls when tools present", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          name: "get_weather",
          description: "Get current weather",
          input_schema: { type: "object", properties: {} },
        },
      ],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.tool_choice, "auto");
    assert.equal(result.parallel_tool_calls, true);
  });

  it("should default parallel_tool_calls to true even before tools are declared", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.parallel_tool_calls, true);
  });

  it("should disable parallel_tool_calls without requiring tools in the request", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      tool_choice: { disable_parallel_tool_use: true },
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.parallel_tool_calls, false);
  });

  it("should strip Anthropic-specific fields (betas, metadata, thinking, stream_options)", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      betas: ["prompt-caching-2024-07-31"],
      metadata: { user_id: "test" },
      thinking: { type: "enabled", budget_tokens: 5000 },
      stream_options: { include_usage: true },
    };

    const result = anthropicToCodex(req) as unknown as Record<
      string,
      unknown
    >;

    assert.equal(result.betas, undefined);
    assert.equal(result.metadata, undefined);
    assert.equal(result.thinking, undefined);
    assert.equal(result.stream_options, undefined);
  });

  it("should map thinking budget to reasoning effort", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      thinking: { type: "enabled", budget_tokens: 15000 },
    };

    const result = anthropicToCodex(req);

    assert.ok(result.reasoning);
    assert.equal(result.reasoning!.effort, "high");
  });

  it("should default to medium reasoning when Claude Code does not send thinking config", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = anthropicToCodex(req);

    assert.deepEqual(result.reasoning, {
      effort: "medium",
      summary: "auto",
    });
  });

  it("should always include reasoning.encrypted_content in include", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = anthropicToCodex(req);

    assert.ok(Array.isArray(result.include));
    assert.deepEqual(result.include, ["reasoning.encrypted_content"]);
  });

  it("should respect disable_parallel_tool_use when Claude Code requests serial tools", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      tool_choice: { disable_parallel_tool_use: true },
      tools: [
        {
          name: "get_weather",
          description: "Get current weather",
          input_schema: { type: "object", properties: {} },
        },
      ],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.parallel_tool_calls, false);
  });

  it("should shorten long tool names consistently across tools and tool_use history", () => {
    const longToolName =
      "mcp__workspace__super_long_tool_name_that_keeps_going_for_claude_code_roundtrip_validation";
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: longToolName,
              input: { path: "/tmp/demo" },
            },
          ],
        },
      ],
      tools: [
        {
          name: longToolName,
          description: "Long MCP tool name",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    };

    const result = anthropicToCodex(req);
    const tool = asFunctionTool(result.tools![0]);
    const functionCall = result.input[0] as {
      type: "function_call";
      name: string;
    };

    assert.ok(tool.name.length <= 64);
    assert.equal(functionCall.name, tool.name);
    assert.notEqual(tool.name, longToolName);
  });

  it("should map Claude web_search built-ins to Codex web_search", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Search the web" }],
      tools: [{ type: "web_search_20250305" }],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.tools?.[0]?.type, "web_search");
  });

  it("should preserve structured tool_result content with text and images", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: [
                { type: "text", text: "Screenshot from tool" },
                {
                  type: "image",
                  source: {
                    type: "url",
                    url: "https://example.com/tool.png",
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const result = anthropicToCodex(req);
    const toolOutput = result.input[0] as {
      type: "function_call_output";
      output: Array<{ type: string; text?: string; image_url?: string }>;
    };

    assert.equal(toolOutput.type, "function_call_output");
    assert.deepEqual(toolOutput.output, [
      { type: "input_text", text: "Screenshot from tool" },
      {
        type: "input_image",
        image_url: "https://example.com/tool.png",
      },
    ]);
  });

  it("should only contain whitelisted fields", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      betas: ["test"],
      metadata: { user: "x" },
      thinking: { type: "enabled" },
      stream_options: {},
      max_output_tokens: 2048,
    };

    const result = anthropicToCodex(req);
    const keys = Object.keys(result);

    // Only whitelisted keys should be present
    const allowedKeys = new Set([
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
    ]);
    for (const key of keys) {
      assert.ok(
        allowedKeys.has(key),
        `Unexpected key "${key}" in Codex request`
      );
    }
  });
});

const SCHEMA_MAP_KEYS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
];

const SCHEMA_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"];

const SCHEMA_VALUE_KEYS = [
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
];

const REAL_TOOL_SCHEMA_FIXTURES: Record<string, Record<string, unknown>> = {
  ExitPlanMode: {
    properties: {
      allowedPrompts: {
        type: "array",
        items: {
          properties: {
            tool: { enum: ["Bash"] },
            prompt: { type: "string" },
          },
        },
      },
    },
  },
  AskUserQuestion: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          properties: {
            question: { type: "string" },
            header: { type: "string" },
            options: {
              type: "array",
              items: {
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                  preview: { type: "string", format: "uri" },
                },
              },
            },
            multiSelect: { type: "boolean" },
          },
        },
      },
      answers: {
        type: "object",
        additionalProperties: { type: "string", format: "date-time" },
      },
      annotations: {
        type: "object",
        additionalProperties: {
          properties: {
            preview: { type: "string", format: "uri" },
            notes: { type: "string" },
          },
        },
      },
      metadata: {
        properties: {
          source: { type: "string" },
        },
      },
    },
  },
  WebFetch: {
    type: "object",
    properties: {
      url: { type: "string", format: "uri" },
      prompt: { type: "string" },
    },
  },
  Agent: {
    type: "object",
    properties: {
      description: { type: "string" },
      prompt: { type: "string" },
      subagent_type: { type: "string" },
      model: { enum: ["sonnet", "opus", "haiku"] },
      resume: { type: "string" },
      run_in_background: { type: "boolean" },
    },
  },
  Bash: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number" },
      description: { type: "string" },
      run_in_background: { type: "boolean" },
      dangerouslyDisableSandbox: { type: "boolean" },
      _simulatedSedEdit: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          newContent: { type: "string" },
        },
      },
    },
  },
  TaskCreate: {
    type: "object",
    properties: {
      subject: { type: "string" },
      description: { type: "string" },
      activeForm: { type: "string" },
      metadata: {
        type: "object",
        additionalProperties: {},
      },
    },
    required: ["subject", "description"],
  },
  Read: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
      pages: { type: "string" },
    },
  },
  Edit: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean", default: false },
    },
  },
  TodoWrite: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          properties: {
            content: { type: "string" },
            status: { enum: ["pending", "in_progress", "completed"] },
            activeForm: { type: "string" },
          },
        },
      },
    },
  },
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function visitSchemaNodes(
  node: unknown,
  visitor: (schema: Record<string, unknown>) => void
): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      visitSchemaNodes(item, visitor);
    }
    return;
  }

  if (!isObjectRecord(node)) {
    return;
  }

  visitor(node);

  for (const key of SCHEMA_MAP_KEYS) {
    const value = node[key];
    if (isObjectRecord(value)) {
      for (const child of Object.values(value)) {
        visitSchemaNodes(child, visitor);
      }
    }
  }

  for (const key of SCHEMA_ARRAY_KEYS) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        visitSchemaNodes(child, visitor);
      }
    }
  }

  for (const key of SCHEMA_VALUE_KEYS) {
    const value = node[key];
    if (typeof value === "boolean") {
      continue;
    }
    visitSchemaNodes(value, visitor);
  }
}

function assertSchemaInvariants(node: unknown): void {
  visitSchemaNodes(node, (schema) => {
    assert.equal(schema.format, undefined);
    assert.equal(schema.oneOf, undefined);
    assert.equal(schema.allOf, undefined);

    const properties = schema.properties;
    if (!isObjectRecord(properties)) {
      return;
    }

    assert.equal(schema.type, "object");

    if (schema.required !== undefined) {
      assert.ok(Array.isArray(schema.required));
      for (const entry of schema.required as string[]) {
        assert.equal(typeof entry, "string");
        assert.ok(entry in properties);
      }
    }
  });
}

describe("sanitizeToolSchema", () => {
  it("should strip format from property definitions", () => {
    const schema = {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        name: { type: "string" },
      },
      required: ["url"],
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const props = result.properties as Record<string, Record<string, unknown>>;
    assert.equal(props.url.type, "string");
    assert.equal(props.url.format, undefined);
    assert.equal(props.name.type, "string");
  });

  it("should strip format from deeply nested schemas", () => {
    const schema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            endpoint: { type: "string", format: "uri" },
            timeout: { type: "integer", format: "int32" },
          },
        },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const config = (result.properties as Record<string, Record<string, unknown>>).config;
    const nested = config.properties as Record<string, Record<string, unknown>>;
    assert.equal(nested.endpoint.format, undefined);
    assert.equal(nested.endpoint.type, "string");
    assert.equal(nested.timeout.format, undefined);
  });

  it("should strip format inside items (array schemas)", () => {
    const schema = {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string", format: "uri" },
        },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const urls = (result.properties as Record<string, Record<string, unknown>>).urls;
    const items = urls.items as Record<string, unknown>;
    assert.equal(items.type, "string");
    assert.equal(items.format, undefined);
  });

  it("should strip format inside anyOf branches", () => {
    const schema = {
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "string", format: "date-time" },
            { type: "number", format: "double" },
          ],
        },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const value = (result.properties as Record<string, Record<string, unknown>>).value;
    const anyOf = value.anyOf as Array<Record<string, unknown>>;
    assert.equal(anyOf[0].format, undefined);
    assert.equal(anyOf[0].type, "string");
    assert.equal(anyOf[1].format, undefined);
    assert.equal(anyOf[1].type, "number");
  });

  it("should strip oneOf and allOf after recursively normalizing their branches", () => {
    const schema = {
      type: "object",
      properties: {
        choice: {
          oneOf: [
            {
              type: "object",
              properties: {
                mode: { type: "string", format: "uri" },
              },
            },
            { type: "string", format: "date-time" },
          ],
        },
        combined: {
          allOf: [
            {
              type: "object",
              properties: {
                a: { type: "string", format: "hostname" },
              },
            },
            {
              type: "object",
              properties: {
                b: { type: "number", format: "double" },
              },
            },
          ],
        },
      },
    };

    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const props = result.properties as Record<string, Record<string, unknown>>;

    assert.equal(props.choice.oneOf, undefined);
    assert.equal(props.choice.type, "object");

    assert.equal(props.combined.allOf, undefined);
    assert.equal(props.combined.type, "object");
  });

  it("should strip $schema, $id, $ref, examples, and other unsupported keywords", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "test",
      type: "object",
      properties: {
        name: {
          type: "string",
          examples: ["Alice", "Bob"],
          contentEncoding: "utf-8",
          contentMediaType: "text/plain",
          minLength: 1,
          maxLength: 100,
          pattern: "^[a-zA-Z]+$",
        },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    assert.equal(result.$schema, undefined);
    assert.equal(result.$id, undefined);
    const name = (result.properties as Record<string, Record<string, unknown>>).name;
    assert.equal(name.type, "string");
    assert.equal(name.examples, undefined);
    assert.equal(name.contentEncoding, undefined);
    assert.equal(name.contentMediaType, undefined);
    assert.equal(name.minLength, undefined);
    assert.equal(name.maxLength, undefined);
    assert.equal(name.pattern, undefined);
  });

  it("should preserve declared required keys while filtering invalid entries", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner_a: { type: "string" },
            inner_b: { type: "number" },
          },
          required: ["inner_a"], // only partial
        },
      },
      required: [], // empty
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    assert.deepEqual(result.required, []);
    const outer = (result.properties as Record<string, Record<string, unknown>>).outer;
    assert.deepEqual(outer.required, ["inner_a"]);
  });

  it("should drop required keys that are no longer present in properties", () => {
    const schema = {
      type: "object",
      properties: {
        question: { type: "string" },
      },
      required: ["question", "answers"],
    };

    const result = sanitizeToolSchema(schema) as Record<string, unknown>;

    assert.deepEqual(result.required, ["question"]);
  });

  it("should exclude pure record container properties from required", () => {
    const schema = {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: { type: "string" },
        },
        answers: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        metadata: {
          type: "object",
          properties: {
            source: { type: "string" },
          },
        },
      },
      required: ["questions"],
    };

    const result = sanitizeToolSchema(schema) as Record<string, unknown>;

    assert.deepEqual(result.required, ["questions"]);
  });

  it("should normalize unknown record value schemas without forcing extra object constraints", () => {
    const schema = {
      type: "object",
      properties: {
        metadata: {
          type: "object",
          additionalProperties: {},
        },
      },
    };

    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const metadata = (result.properties as Record<string, Record<string, unknown>>)
      .metadata;
    const metadataValue = metadata.additionalProperties as Record<string, unknown>;

    assert.equal(metadata.type, "object");
    assert.ok(isObjectRecord(metadata.additionalProperties));
    assert.equal(metadataValue.type, "object");
  });

  it("should exclude stripped combinator shells from required", () => {
    const schema = {
      type: "object",
      properties: {
        choice: {
          oneOf: [{ type: "string" }, { type: "number" }],
        },
        combo: {
          allOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "string" } } },
          ],
        },
      },
      required: ["choice", "combo"],
    };

    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const props = result.properties as Record<string, Record<string, unknown>>;

    assert.deepEqual(result.required, ["choice", "combo"]);
    assert.equal(props.choice.type, "object");
    assert.equal(props.combo.type, "object");
  });

  it("should preserve explicit additionalProperties settings when not tightening schemas", () => {
    const schema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {
            x: { type: "string" },
          },
          additionalProperties: true,
        },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    assert.equal(result.additionalProperties, undefined);
    const nested = (result.properties as Record<string, Record<string, unknown>>).nested;
    assert.equal(nested.additionalProperties, true);
  });

  it("should handle primitives and null gracefully", () => {
    assert.equal(sanitizeToolSchema(null), null);
    assert.equal(sanitizeToolSchema(undefined), undefined);
    assert.equal(sanitizeToolSchema("string"), "string");
    assert.equal(sanitizeToolSchema(42), 42);
    assert.equal(sanitizeToolSchema(true), true);
  });

  it("should normalize the real tool schema fixtures without mutating them", () => {
    for (const [name, fixture] of Object.entries(REAL_TOOL_SCHEMA_FIXTURES)) {
      const original = structuredClone(fixture);
      const result = sanitizeToolSchema(fixture);

      assert.ok(isObjectRecord(result), `${name} should sanitize to an object`);
      assertSchemaInvariants(result);
      assert.deepEqual(fixture, original, `${name} fixture should not be mutated`);
    }
  });

  it("should preserve enum and const values", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["read", "write"] },
        version: { const: 2 },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const props = result.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(props.mode.enum, ["read", "write"]);
    assert.equal(props.version.const, 2);
  });

  it("should sanitize nested properties inside anyOf branches", () => {
    const schema = {
      type: "object",
      properties: {
        value: {
          anyOf: [
            {
              type: "object",
              properties: {
                name: { type: "string", format: "hostname" },
                port: { type: "integer", minimum: 0, maximum: 65535 },
              },
              required: ["name"],
            },
            { type: "string", format: "uri" },
          ],
        },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const value = (result.properties as Record<string, Record<string, unknown>>).value;
    const anyOf = value.anyOf as Array<Record<string, unknown>>;
    // First branch: object with properties
    const branch0Props = anyOf[0].properties as Record<string, Record<string, unknown>>;
    assert.equal(branch0Props.name.format, undefined);
    assert.equal(branch0Props.name.type, "string");
    assert.equal((branch0Props.port as Record<string, unknown>).minimum, undefined);
    assert.equal((branch0Props.port as Record<string, unknown>).maximum, undefined);
    assert.deepEqual(anyOf[0].required, ["name"]);
    // Second branch: format stripped
    assert.equal(anyOf[1].format, undefined);
    assert.equal(anyOf[1].type, "string");
  });

  it("should preserve primitive values inside enum arrays and const", () => {
    const schema = {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "inactive", null] },
        count: { type: "integer", const: 42, format: "int32" },
        flag: { type: "boolean", default: true },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const props = result.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(props.status.enum, ["active", "inactive", null]);
    assert.equal(props.count.const, 42);
    assert.equal(props.count.format, undefined); // format still stripped
    assert.equal(props.flag.default, true);
  });

  it("should recurse into schema-valued additionalProperties", () => {
    const schema = {
      type: "object",
      properties: {
        annotations: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              preview: { type: "string", format: "uri" },
              score: { type: "number", minimum: 0 },
            },
            required: [],
          },
        },
      },
    };

    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const annotations = (result.properties as Record<string, Record<string, unknown>>)
      .annotations;
    const nested = annotations.additionalProperties as Record<string, unknown>;
    const nestedProps = nested.properties as Record<string, Record<string, unknown>>;

    assert.equal(nestedProps.preview.format, undefined);
    assert.equal((nestedProps.score as Record<string, unknown>).minimum, undefined);
    assert.deepEqual(nested.required, []);
  });

  it("should add type: object to schema nodes missing a type field (Codex requirement)", () => {
    // ExitPlanMode-style: additionalProperties is a schema object with no type
    const schema = {
      type: "object",
      properties: {
        metadata: {
          type: "object",
          additionalProperties: {
            // intentionally no 'type' — this triggers the Codex 400 error
            properties: {
              label: { type: "string" },
            },
          },
        },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const metadata = (result.properties as Record<string, Record<string, unknown>>).metadata;
    const ap = metadata.additionalProperties as Record<string, unknown>;
    assert.equal(ap.type, "object"); // inferred from presence of properties
  });

  it("should infer type: array when schema node has items but no type", () => {
    const schema = {
      type: "object",
      properties: {
        tags: {
          // no 'type', but has 'items' → should infer "array"
          items: { type: "string" },
        },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const tags = (result.properties as Record<string, Record<string, unknown>>).tags;
    assert.equal(tags.type, "array");
  });

  it("should default missing enum-only schemas to object", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { enum: ["read", "write"] },
        count: { enum: [1, 2, 3] },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const props = result.properties as Record<string, Record<string, unknown>>;
    assert.equal(props.mode.type, "object");
    assert.equal(props.count.type, "object");
  });

  it("should default missing const-only schemas to object", () => {
    const schema = {
      type: "object",
      properties: {
        version: { const: 2 },
        name: { const: "default" },
        flag: { const: true },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const props = result.properties as Record<string, Record<string, unknown>>;
    assert.equal(props.version.type, "object");
    assert.equal(props.name.type, "object");
    assert.equal(props.flag.type, "object");
  });

  it("should add type: object to schema node with anyOf when type is missing", () => {
    const schema = {
      type: "object",
      properties: {
        value: {
          // no type at this level — only anyOf
          anyOf: [
            { type: "string" },
            { type: "number" },
          ],
        },
      },
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const value = (result.properties as Record<string, Record<string, unknown>>).value;
    // No properties/items/enum/const → defaults to "object"
    assert.equal(value.type, "object");
  });

  it("should not overwrite an existing type field", () => {
    const schema = {
      type: "string",
      description: "a string field",
    };
    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    assert.equal(result.type, "string");
  });

  it("should strip unsupported recursive schema containers without mutating the input", () => {
    const schema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          patternProperties: {
            ".*": {
              type: "object",
              properties: {
                enabled: { type: "boolean", readOnly: true },
              },
            },
          },
          definitions: {
            branch: {
              type: "object",
              properties: {
                name: { type: "string", examples: ["main"] },
              },
            },
          },
          if: {
            properties: {
              mode: { const: "advanced" },
            },
          },
          then: {
            properties: {
              threshold: { type: "integer", minimum: 1 },
            },
          },
          else: {
            properties: {
              threshold: { type: "integer", maximum: 0 },
            },
          },
        },
      },
    };
    const original = structuredClone(schema);

    const result = sanitizeToolSchema(schema) as Record<string, unknown>;
    const config = (result.properties as Record<string, Record<string, unknown>>).config;
    assert.equal(config.patternProperties, undefined);
    assert.equal(config.definitions, undefined);
    assert.equal(config.if, undefined);
    assert.equal(config.then, undefined);
    assert.equal(config.else, undefined);
    assert.deepEqual(schema, original);
  });
});

describe("anthropicToCodex tool schema sanitization (integration)", () => {
  it("should normalize ExitPlanMode into a backend-safe object schema", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "exit plan mode" }],
      tools: [
        {
          name: "ExitPlanMode",
          description: "Exit plan mode",
          input_schema: structuredClone(REAL_TOOL_SCHEMA_FIXTURES.ExitPlanMode),
        },
      ],
    };

    const result = anthropicToCodex(req);
    const params = asFunctionTool(result.tools![0]).parameters;
    const allowedPrompts = (params.properties as Record<string, Record<string, unknown>>)
      .allowedPrompts;
    const promptItem = allowedPrompts.items as Record<string, unknown>;

    assert.equal(params.type, "object");
    assert.equal(params.additionalProperties, undefined);
    assert.equal(params.required, undefined);
    assert.equal(promptItem.type, "object");
    assert.equal(promptItem.additionalProperties, undefined);
    assert.equal(promptItem.required, undefined);
    assertSchemaInvariants(params);
  });

  it("should normalize AskUserQuestion nested record schemas without dropping recursion", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "ask a question" }],
      tools: [
        {
          name: "AskUserQuestion",
          description: "Ask the user a question",
          input_schema: structuredClone(REAL_TOOL_SCHEMA_FIXTURES.AskUserQuestion),
        },
      ],
    };

    const result = anthropicToCodex(req);
    const params = asFunctionTool(result.tools![0]).parameters;
    const props = params.properties as Record<string, Record<string, unknown>>;
    const answers = props.answers;
    const annotations = props.annotations;
    const annotationValue = annotations.additionalProperties as Record<string, unknown>;
    const metadata = props.metadata;

    assert.equal(params.additionalProperties, undefined);
    assert.equal(params.required, undefined);
    assert.ok(isObjectRecord(answers.additionalProperties));
    assert.equal(
      (answers.additionalProperties as Record<string, unknown>).format,
      undefined
    );
    assert.equal(params.required, undefined);
    assert.equal(annotationValue.type, "object");
    assert.equal(annotationValue.additionalProperties, undefined);
    assert.equal(annotationValue.required, undefined);
    assert.equal(metadata.type, "object");
    assert.equal(metadata.additionalProperties, undefined);
    assert.equal(metadata.required, undefined);
    assertSchemaInvariants(params);
  });

  it("should normalize TaskCreate unknown record values for Codex", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "create a task" }],
      tools: [
        {
          name: "TaskCreate",
          description: "Create a task",
          input_schema: structuredClone(REAL_TOOL_SCHEMA_FIXTURES.TaskCreate),
        },
      ],
    };

    const result = anthropicToCodex(req);
    const params = asFunctionTool(result.tools![0]).parameters;
    const metadata = (params.properties as Record<string, Record<string, unknown>>)
      .metadata;
    const metadataValue = metadata.additionalProperties as Record<string, unknown>;

    assert.deepEqual(
      new Set((params.required as string[]) ?? []),
      new Set(["subject", "description"])
    );
    assert.equal(metadata.type, "object");
    assert.ok(isObjectRecord(metadata.additionalProperties));
    assert.equal(metadataValue.type, "object");
    assert.equal(metadataValue.additionalProperties, undefined);
  });

  it("should strip format:uri from WebFetch-like tool", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "fetch" }],
      tools: [
        {
          name: "WebFetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string", format: "uri" },
              raw: { type: "boolean" },
            },
            required: ["url"],
          },
        },
      ],
    };
    const result = anthropicToCodex(req);
    const params = asFunctionTool(result.tools![0]).parameters;
    const url = (params.properties as Record<string, Record<string, unknown>>).url;
    assert.equal(url.type, "string");
    assert.equal(url.format, undefined);
    assert.ok((params.required as string[]).includes("url"));
    assert.ok(!(params.required as string[]).includes("raw"));
    assert.equal(params.additionalProperties, undefined);
    assertSchemaInvariants(params);
  });

  it("should strip all unsupported keywords from complex tool schemas", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "test" }],
      tools: [
        {
          name: "ComplexTool",
          description: "Complex",
          input_schema: {
            type: "object",
            $schema: "http://json-schema.org/draft-07/schema#",
            properties: {
              endpoint: { type: "string", format: "uri", minLength: 1 },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "integer", format: "int64" },
                    tags: {
                      type: "array",
                      items: { type: "string", pattern: "^[a-z]+$" },
                    },
                  },
                },
              },
            },
            required: ["endpoint"],
          },
        },
      ],
    };
    const result = anthropicToCodex(req);
    const params = asFunctionTool(result.tools![0]).parameters;
    // $schema stripped at top
    assert.equal((params as unknown as Record<string, unknown>).$schema, undefined);
    // format stripped from endpoint
    const endpoint = (params.properties as Record<string, Record<string, unknown>>).endpoint;
    assert.equal(endpoint.format, undefined);
    assert.equal((endpoint as Record<string, unknown>).minLength, undefined);
    // format stripped from nested items
    const itemsArr = (params.properties as Record<string, Record<string, unknown>>).items;
    const itemSchema = itemsArr.items as Record<string, unknown>;
    const idProp = ((itemSchema as Record<string, Record<string, unknown>>).properties as Record<string, Record<string, unknown>>).id;
    assert.equal(idProp.format, undefined);
    // pattern stripped from deeply nested tags items
    const tagsProp = ((itemSchema as Record<string, Record<string, unknown>>).properties as Record<string, Record<string, unknown>>).tags;
    const tagsItems = tagsProp.items as Record<string, unknown>;
    assert.equal(tagsItems.pattern, undefined);
    assertSchemaInvariants(params);
  });

  it("should exclude stripped combinator shells from top-level required keys", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "probe combinators" }],
      tools: [
        {
          name: "SchemaProbe",
          description: "Probe stripped combinators",
          input_schema: {
            type: "object",
            properties: {
              choice: {
                oneOf: [{ type: "string" }, { type: "number" }],
              },
              combo: {
                allOf: [
                  {
                    type: "object",
                    properties: { a: { type: "string" } },
                  },
                  {
                    type: "object",
                    properties: { b: { type: "string" } },
                  },
                ],
              },
            },
          },
        },
      ],
    };

    const result = anthropicToCodex(req);
    const params = asFunctionTool(result.tools![0]).parameters;

    assert.equal(params.required, undefined);
    assertSchemaInvariants(params);
  });

  it("should preserve recursive normalization for schema-valued additionalProperties in converted tools", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "test" }],
      tools: [
        {
          name: "AskUserQuestion",
          description: "Ask the user a question",
          input_schema: {
            type: "object",
            properties: {
              annotations: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  properties: {
                    preview: { type: "string", format: "uri" },
                    label: { type: "string" },
                  },
                },
              },
            },
          },
        },
      ],
    };

    const result = anthropicToCodex(req);
    const params = asFunctionTool(result.tools![0]).parameters;
    const annotations = (params.properties as Record<string, Record<string, unknown>>)
      .annotations;
    const nested = annotations.additionalProperties as Record<string, unknown>;
    const nestedProps = nested.properties as Record<string, Record<string, unknown>>;

    assert.equal(nestedProps.preview.format, undefined);
    assert.equal(nested.required, undefined);
  });

  it("should normalize Agent tools used for subagents", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "delegate this task" }],
      tools: [
        {
          name: "Agent",
          description: "Spawn a subagent",
          input_schema: structuredClone(REAL_TOOL_SCHEMA_FIXTURES.Agent),
        },
      ],
    };

    const result = anthropicToCodex(req);
    const params = asFunctionTool(result.tools![0]).parameters;
    const props = params.properties as Record<string, Record<string, unknown>>;

    assert.equal(asFunctionTool(result.tools![0]).name, "Agent");
    assert.deepEqual(props.model.enum, ["sonnet", "opus", "haiku"]);
    assert.equal(props.run_in_background.type, "boolean");
    assert.equal(props.subagent_type.type, "string");
    assertSchemaInvariants(params);
  });

  it("should normalize Bash, Read, Edit, and TodoWrite built-ins", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "do work" }],
      tools: [
        {
          name: "Bash",
          description: "Run a shell command",
          input_schema: structuredClone(REAL_TOOL_SCHEMA_FIXTURES.Bash),
        },
        {
          name: "Read",
          description: "Read a file",
          input_schema: structuredClone(REAL_TOOL_SCHEMA_FIXTURES.Read),
        },
        {
          name: "Edit",
          description: "Edit a file",
          input_schema: structuredClone(REAL_TOOL_SCHEMA_FIXTURES.Edit),
        },
        {
          name: "TodoWrite",
          description: "Update todos",
          input_schema: structuredClone(REAL_TOOL_SCHEMA_FIXTURES.TodoWrite),
        },
      ],
    };

    const result = anthropicToCodex(req);
    const names = result.tools!.map((tool) => asFunctionTool(tool).name);
    assert.deepEqual(names, ["Bash", "Read", "Edit", "TodoWrite"]);

    for (const tool of result.tools!) {
      const functionTool = asFunctionTool(tool);
      assert.equal(functionTool.strict, false);
      assert.equal(functionTool.parameters.additionalProperties, undefined);
      assertSchemaInvariants(functionTool.parameters);
    }

    const bashParams = asFunctionTool(result.tools![0]).parameters;
    const bashNested = (
      (bashParams.properties as Record<string, Record<string, unknown>>)
        ._simulatedSedEdit.properties as Record<string, Record<string, unknown>>
    );
    assert.equal(bashNested.filePath.type, "string");
    assert.equal(bashNested.newContent.type, "string");
  });

  it("should preserve MCP tool names and normalize MCP schemas", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "create an issue" }],
      tools: [
        {
          name: "mcp__github__create_issue",
          description: "Create a GitHub issue through MCP",
          input_schema: {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
              title: { type: "string" },
              body: { type: "string" },
              metadata: {
                type: "object",
                additionalProperties: {
                  type: "string",
                  format: "uri",
                },
              },
            },
          },
        },
      ],
    };

    const result = anthropicToCodex(req);
    const tool = asFunctionTool(result.tools![0]);
    const params = tool.parameters;
    const metadata = (
      params.properties as Record<string, Record<string, unknown>>
    ).metadata;
    const metadataValue = metadata.additionalProperties as Record<string, unknown>;

    assert.equal(tool.name, "mcp__github__create_issue");
    assert.equal(metadataValue.type, "string");
    assert.equal(metadataValue.format, undefined);
    assertSchemaInvariants(params);
  });

  it("should support Skill and MCP resource tools as regular function tools", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "use skills and MCP resources" }],
      tools: [
        {
          name: "Skill",
          description: "Execute a skill",
          input_schema: {
            type: "object",
            properties: {
              skill_name: { type: "string" },
              arguments: { type: "string" },
            },
          },
        },
        {
          name: "ListMcpResourcesTool",
          description: "List MCP resources",
          input_schema: {
            type: "object",
            properties: {
              server: { type: "string" },
              cursor: { type: "string" },
            },
          },
        },
        {
          name: "ReadMcpResourceTool",
          description: "Read MCP resource",
          input_schema: {
            type: "object",
            properties: {
              server: { type: "string" },
              uri: { type: "string", format: "uri" },
            },
          },
        },
      ],
    };

    const result = anthropicToCodex(req);
    const names = result.tools!.map((tool) => asFunctionTool(tool).name);
    assert.deepEqual(names, [
      "Skill",
      "ListMcpResourcesTool",
      "ReadMcpResourceTool",
    ]);

    const readMcpParams = asFunctionTool(result.tools![2]).parameters;
    const uri = (
      readMcpParams.properties as Record<string, Record<string, unknown>>
    ).uri;
    assert.equal(uri.type, "string");
    assert.equal(uri.format, undefined);

    for (const tool of result.tools!) {
      const functionTool = asFunctionTool(tool);
      assert.equal(functionTool.type, "function");
      assert.equal(functionTool.strict, false);
      assertSchemaInvariants(functionTool.parameters);
    }
  });
});

describe("codexToAnthropic", () => {
  it("should convert a simple Responses API response", () => {
    const codexRes = {
      id: "resp_abc123",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Hello from Codex!" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = codexToAnthropic(codexRes, "claude-3-5-sonnet-20241022");

    assert.equal(result.type, "message");
    assert.equal(result.role, "assistant");
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.equal(
      (result.content[0] as { type: "text"; text: string }).text,
      "Hello from Codex!"
    );
    assert.equal(result.model, "claude-3-5-sonnet-20241022");
    assert.equal(result.stop_reason, "end_turn");
    assert.equal(result.usage.input_tokens, 10);
    assert.equal(result.usage.output_tokens, 5);
  });

  it("should handle function_call output", () => {
    const codexRes = {
      id: "resp_abc123",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "call_123",
          name: "get_weather",
          arguments: '{"location":"Tokyo"}',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 15 },
    };

    const result = codexToAnthropic(codexRes, "claude-3-5-sonnet-20241022");

    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "tool_use");
    assert.equal(result.stop_reason, "tool_use");
  });

  it("should fallback to Chat Completions format", () => {
    const codexRes = {
      id: "chatcmpl-abc123",
      choices: [
        {
          message: { role: "assistant", content: "Hello!" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };

    const result = codexToAnthropic(codexRes, "claude-3-5-sonnet-20241022");

    assert.equal(result.content.length, 1);
    assert.equal(
      (result.content[0] as { type: "text"; text: string }).text,
      "Hello!"
    );
    assert.equal(result.stop_reason, "end_turn");
  });

  it("should handle incomplete status as max_tokens", () => {
    const codexRes = {
      id: "resp_abc123",
      status: "incomplete",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Partial..." }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 100 },
    };

    const result = codexToAnthropic(codexRes, "claude-3-5-sonnet-20241022");

    assert.equal(result.stop_reason, "max_tokens");
  });

  it("should restore original tool names from shortened Codex names", () => {
    const originalName =
      "mcp__workspace__super_long_tool_name_that_keeps_going_for_claude_code_roundtrip_validation";
    const shortenedName = asFunctionTool(
      anthropicToCodex({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            name: originalName,
            description: "Long MCP tool name",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }).tools![0]
    ).name;
    const codexRes = {
      id: "resp_abc123",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_123",
          name: shortenedName,
          arguments: '{"location":"Tokyo"}',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 15 },
    };

    const result = codexToAnthropic(codexRes, "claude-3-5-sonnet-20241022", [
      {
        name: originalName,
        description: "Long MCP tool name",
        input_schema: { type: "object", properties: {} },
      },
    ]);

    assert.equal(result.content[0].type, "tool_use");
    assert.equal(
      (result.content[0] as { type: "tool_use"; name: string }).name,
      originalName
    );
  });

  it("should surface reasoning output as Anthropic thinking blocks", () => {
    const codexRes = {
      id: "resp_abc123",
      status: "completed",
      output: [
        {
          type: "reasoning",
          summary: [{ text: "plan first" }],
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "done" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = codexToAnthropic(codexRes, "claude-3-5-sonnet-20241022");

    assert.equal(result.content[0].type, "thinking");
    assert.equal(
      (result.content[0] as { type: "thinking"; thinking: string }).thinking,
      "plan first"
    );
    assert.equal(
      (result.content[1] as { type: "text"; text: string }).text,
      "done"
    );
  });
});

describe("StreamConverter", () => {
  it("should emit message_start on first event", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    const events = converter.processEvent("response.output_text.delta", {
      delta: "Hello",
    });

    assert.ok(events.length > 0);
    assert.ok(events[0].includes("message_start"));
    assert.ok(events.some((e) => e.includes("ping")));
    assert.ok(events.some((e) => e.includes("text_delta")));
    assert.ok(events.some((e) => e.includes("Hello")));
  });

  it("should emit content_block_stop on text done", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    converter.processEvent("response.output_text.delta", { delta: "Hi" });
    const events = converter.processEvent("response.output_text.done", {
      text: "Hi",
    });

    assert.ok(events.some((e) => e.includes("content_block_stop")));
  });

  it("should emit message_stop on response.completed", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    converter.processEvent("response.output_text.delta", { delta: "Hi" });
    converter.processEvent("response.output_text.done", { text: "Hi" });
    const events = converter.processEvent("response.completed", {
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    assert.ok(events.some((e) => e.includes("message_delta")));
    assert.ok(events.some((e) => e.includes("message_stop")));
    assert.ok(events.some((e) => e.includes("end_turn")));
  });

  it("should handle tool_use in streaming", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    converter.processEvent("response.output_text.delta", {
      delta: "Let me check.",
    });
    converter.processEvent("response.output_text.done", {
      text: "Let me check.",
    });
    const events = converter.processEvent("response.output_item.done", {
      item: {
        type: "function_call",
        id: "call_123",
        name: "get_weather",
        arguments: '{"location":"Tokyo"}',
      },
    });

    assert.ok(events.some((e) => e.includes("tool_use")));
    assert.ok(events.some((e) => e.includes("get_weather")));
  });

  it("should finalize properly if no completion event", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    converter.processEvent("response.output_text.delta", { delta: "Hi" });
    const events = converter.finalize();

    assert.ok(events.some((e) => e.includes("content_block_stop")));
    assert.ok(events.some((e) => e.includes("message_delta")));
    assert.ok(events.some((e) => e.includes("message_stop")));
  });

  it("should not emit duplicate message_stop when finalize is called after response.completed", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    converter.processEvent("response.output_text.delta", { delta: "Hi" });
    converter.processEvent("response.output_text.done", { text: "Hi" });
    converter.processEvent("response.completed", {
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const events = converter.finalize();
    assert.equal(events.length, 0);
  });

  it("should handle Chat Completions streaming format", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    const events = converter.processEvent("", {
      choices: [{ delta: { content: "Hello" }, finish_reason: null }],
    });

    assert.ok(events.some((e) => e.includes("text_delta")));
    assert.ok(events.some((e) => e.includes("Hello")));
  });

  it("should handle response.reasoning_summary_text.delta without error", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    const events = converter.processEvent(
      "response.reasoning_summary_text.delta",
      { delta: "reasoning...", summary_index: 0 }
    );
    // Should emit message_start and a thinking delta block.
    assert.ok(events.some((e) => e.includes("message_start")));
    assert.ok(events.some((e) => e.includes("thinking_delta")));
  });

  it("should handle response.reasoning_text.delta without error", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    const events = converter.processEvent(
      "response.reasoning_text.delta",
      { delta: "thinking...", content_index: 0 }
    );
    assert.ok(events.some((e) => e.includes("message_start")));
  });

  it("should handle response.reasoning_summary_part.added without error", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    const events = converter.processEvent(
      "response.reasoning_summary_part.added",
      { summary_index: 0 }
    );
    assert.ok(events.some((e) => e.includes("message_start")));
  });

  it("should stream function_call arguments deltas and restore original long tool names", () => {
    const originalName =
      "mcp__workspace__super_long_tool_name_that_keeps_going_for_claude_code_roundtrip_validation";
    const shortenedName = asFunctionTool(
      anthropicToCodex({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            name: originalName,
            description: "Long MCP tool name",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }).tools![0]
    ).name;
    const converter = new StreamConverter("claude-3-5-sonnet-20241022", [
      {
        name: originalName,
        description: "Long MCP tool name",
        input_schema: { type: "object", properties: {} },
      },
    ]);

    const added = converter.processEvent("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_call_123",
        call_id: "call_123",
        name: shortenedName,
      },
    });
    const delta = converter.processEvent("response.function_call_arguments.delta", {
      item_id: "fc_call_123",
      output_index: 0,
      delta: '{"location":"Tok',
    });

    assert.ok(added.some((e) => e.includes(originalName)));
    assert.ok(delta.some((e) => e.includes("input_json_delta")));
    assert.ok(delta.some((e) => e.includes("location")));
    assert.ok(delta.some((e) => e.includes("Tok")));
  });
});

describe("StreamConverter additional events", () => {
  it("should handle response.created silently", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    const events = converter.processEvent("response.created", {
      response: { id: "resp_123" },
    });

    assert.ok(events.some((e) => e.includes("message_start")));
  });

  it("should handle response.failed as error", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    converter.processEvent("response.output_text.delta", { delta: "Hi" });
    const events = converter.processEvent("response.failed", {
      response: { error: { message: "Something went wrong" } },
    });

    assert.ok(events.some((e) => e.includes("error")));
    assert.ok(events.some((e) => e.includes("message_stop")));
  });

  it("should handle response.incomplete as max_tokens stop", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    converter.processEvent("response.output_text.delta", { delta: "Hi" });
    const events = converter.processEvent("response.incomplete", {
      response: { incomplete_details: { reason: "max_tokens" } },
    });

    assert.ok(events.some((e) => e.includes("max_tokens")));
    assert.ok(events.some((e) => e.includes("message_stop")));
  });

  it("should handle response.output_item.added silently", () => {
    const converter = new StreamConverter("claude-3-5-sonnet-20241022");
    const events = converter.processEvent("response.output_item.added", {
      item: { type: "message", id: "item_123" },
    });

    assert.ok(events.some((e) => e.includes("message_start")));
  });
});

describe("buildErrorResponse", () => {
  it("should build 401 error", () => {
    const res = buildErrorResponse(401, "Unauthorized");
    assert.equal(res.type, "error");
    assert.equal(res.error.type, "authentication_error");
    assert.equal(res.error.message, "Unauthorized");
  });

  it("should build 429 error", () => {
    const res = buildErrorResponse(429, "Rate limited");
    assert.equal(res.error.type, "rate_limit_error");
  });

  it("should build 400 error", () => {
    const res = buildErrorResponse(400, "Bad request");
    assert.equal(res.error.type, "invalid_request_error");
  });

  it("should build generic 500 error", () => {
    const res = buildErrorResponse(500, "Internal error");
    assert.equal(res.error.type, "api_error");
  });
});

describe("estimateTokens", () => {
  it("should estimate tokens roughly", () => {
    assert.equal(estimateTokens("Hello, world!"), 4); // 13 chars / 4 ≈ 4
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("a"), 1);
  });
});

describe("estimateRequestTokens", () => {
  it("should estimate tokens for a request", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: "System prompt",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ],
    };

    const tokens = estimateRequestTokens(req);
    assert.ok(tokens > 0);
  });
});

describe("parseClaudexModelString", () => {
  it("should parse model with reasoning", () => {
    const result = parseClaudexModelString("claudex:gpt-5.3-codex:high");
    assert.ok(result);
    assert.equal(result!.model, "gpt-5.3-codex");
    assert.equal(result!.reasoning, "high");
  });

  it("should parse model without reasoning", () => {
    const result = parseClaudexModelString("claudex:gpt-5.1-codex-max");
    assert.ok(result);
    assert.equal(result!.model, "gpt-5.1-codex-max");
    assert.equal(result!.reasoning, undefined);
  });

  it("should return null for non-claudex model names", () => {
    assert.equal(
      parseClaudexModelString("claude-3-5-sonnet-20241022"),
      null
    );
    assert.equal(parseClaudexModelString("gpt-5.3-codex"), null);
  });
});

describe("mapModel", () => {
  it("should map opus to highest-tier model", () => {
    const saved = proxyConfig.model;
    proxyConfig.model = "";
    const origEnv = process.env.CODEX_MODEL;
    delete process.env.CODEX_MODEL;
    try {
      assert.equal(mapModel("claude-opus-4-20250514"), "gpt-5.4");
    } finally {
      proxyConfig.model = saved;
      if (origEnv !== undefined) process.env.CODEX_MODEL = origEnv;
    }
  });

  it("should map sonnet to mid-tier model", () => {
    const saved = proxyConfig.model;
    proxyConfig.model = "";
    const origEnv = process.env.CODEX_MODEL;
    delete process.env.CODEX_MODEL;
    try {
      assert.equal(
        mapModel("claude-3-5-sonnet-20241022"),
        "gpt-5.4-mini"
      );
    } finally {
      proxyConfig.model = saved;
      if (origEnv !== undefined) process.env.CODEX_MODEL = origEnv;
    }
  });

  it("should map haiku to fast-tier model", () => {
    const saved = proxyConfig.model;
    proxyConfig.model = "";
    const origEnv = process.env.CODEX_MODEL;
    delete process.env.CODEX_MODEL;
    try {
      assert.equal(
        mapModel("claude-3-5-haiku-20241022"),
        "gpt-5.4-nano"
      );
    } finally {
      proxyConfig.model = saved;
      if (origEnv !== undefined) process.env.CODEX_MODEL = origEnv;
    }
  });

  it("should use claudex: convention when present", () => {
    assert.equal(mapModel("claudex:gpt-5.4:medium"), "gpt-5.4");
  });
});

describe("CODEX_MODELS", () => {
  it("should contain expected models from fallback list", () => {
    _resetForTesting();
    const models = getModels();
    assert.ok(models["gpt-5.4"]);
    assert.ok(models["gpt-5.4-mini"]);
    assert.ok(models["gpt-5.4-nano"]);
    assert.equal(models["gpt-5.4"].tier, "high");
    assert.equal(models["gpt-5.4-nano"].tier, "fast");
  });
});
