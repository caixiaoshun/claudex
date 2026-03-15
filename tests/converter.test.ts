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

describe("anthropicToCodex", () => {
  it("should convert a simple text request", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello, world!" }],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.model, "gpt-5.3-codex");
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

  it("should convert system prompt to instructions", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: "You are a helpful coding assistant.",
      messages: [{ role: "user", content: "Help me" }],
    };

    const result = anthropicToCodex(req);

    assert.equal(result.instructions, "You are a helpful coding assistant.");
  });

  it("should convert array system prompt", () => {
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

    assert.equal(result.instructions, "You are helpful.\nBe concise.");
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
    assert.equal(second.content, "Hi there!");
    assert.equal(third.content, "How are you?");
  });

  it("should convert tools to OpenAI format with strict schema", () => {
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

    assert.ok(result.tools);
    assert.equal(result.tools!.length, 1);
    assert.equal(result.tools![0].type, "function");
    assert.equal(result.tools![0].name, "get_weather");
    assert.equal(result.tools![0].description, "Get current weather");
    assert.equal(result.tools![0].strict, true);
    assert.equal(result.tools![0].parameters.additionalProperties, false);
    assert.deepEqual(result.tools![0].parameters.required, ["location"]);
  });

  it("should enforce required includes all property keys", () => {
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

    // All keys from properties must be in required
    const required = result.tools![0].parameters.required as string[];
    assert.ok(required.includes("a"));
    assert.ok(required.includes("b"));
    assert.ok(required.includes("c"));
    assert.equal(required.length, 3);
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
      content: "Let me check the weather.",
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

  it("should always include include field as empty array", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = anthropicToCodex(req);

    assert.ok(Array.isArray(result.include));
    assert.equal(result.include.length, 0);
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

function expectedRequiredKeys(
  properties: Record<string, unknown>
): string[] {
  return Object.entries(properties)
    .filter(([, schema]) => {
      if (!isObjectRecord(schema)) {
        return true;
      }

      return !(
        schema.type === "object" &&
        !isObjectRecord(schema.properties) &&
        schema.items === undefined &&
        isObjectRecord(schema.additionalProperties)
      );
    })
    .filter(([, schema]) => {
      if (!isObjectRecord(schema)) {
        return true;
      }

      return !(
        schema.type === "object" &&
        (!isObjectRecord(schema.properties) ||
          Object.keys(schema.properties).length === 0) &&
        schema.items === undefined &&
        !Array.isArray(schema.anyOf) &&
        schema.enum === undefined &&
        schema.const === undefined &&
        !isObjectRecord(schema.additionalProperties)
      );
    })
    .map(([key]) => key);
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

    const keys = expectedRequiredKeys(properties);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.type, "object");
    assert.deepEqual(
      new Set((schema.required as string[]) ?? []),
      new Set(keys)
    );
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
    assert.equal(props.choice.additionalProperties, false);

    assert.equal(props.combined.allOf, undefined);
    assert.equal(props.combined.type, "object");
    assert.equal(props.combined.additionalProperties, false);
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

  it("should enforce required = all property keys at every level", () => {
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
    // top level: required should include "outer"
    assert.deepEqual(result.required, ["outer"]);
    // nested level: required should include both inner keys
    const outer = (result.properties as Record<string, Record<string, unknown>>).outer;
    const innerRequired = outer.required as string[];
    assert.ok(innerRequired.includes("inner_a"));
    assert.ok(innerRequired.includes("inner_b"));
    assert.equal(innerRequired.length, 2);
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

    assert.deepEqual(result.required, ["questions", "metadata"]);
  });

  it("should force additionalProperties false on unknown record value schemas", () => {
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
    assert.equal(metadataValue.additionalProperties, false);
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

    assert.deepEqual(result.required, []);
    assert.equal(props.choice.type, "object");
    assert.equal(props.choice.additionalProperties, false);
    assert.equal(props.combo.type, "object");
    assert.equal(props.combo.additionalProperties, false);
  });

  it("should enforce additionalProperties = false at every object level", () => {
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
    assert.equal(result.additionalProperties, false);
    const nested = (result.properties as Record<string, Record<string, unknown>>).nested;
    assert.equal(nested.additionalProperties, false);
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
    // required should include all keys in the branch
    assert.deepEqual(anyOf[0].required, ["name", "port"]);
    assert.equal(anyOf[0].additionalProperties, false);
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
    assert.deepEqual(nested.required, ["preview", "score"]);
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
    const params = result.tools![0].parameters as Record<string, unknown>;
    const allowedPrompts = (params.properties as Record<string, Record<string, unknown>>)
      .allowedPrompts;
    const promptItem = allowedPrompts.items as Record<string, unknown>;

    assert.equal(params.type, "object");
    assert.equal(params.additionalProperties, false);
    assert.deepEqual(
      new Set((params.required as string[]) ?? []),
      new Set(["allowedPrompts"])
    );
    assert.equal(promptItem.type, "object");
    assert.equal(promptItem.additionalProperties, false);
    assert.deepEqual(
      new Set((promptItem.required as string[]) ?? []),
      new Set(["tool", "prompt"])
    );
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
    const params = result.tools![0].parameters as Record<string, unknown>;
    const props = params.properties as Record<string, Record<string, unknown>>;
    const answers = props.answers;
    const annotations = props.annotations;
    const annotationValue = annotations.additionalProperties as Record<string, unknown>;
    const metadata = props.metadata;

    assert.equal(params.additionalProperties, false);
    assert.deepEqual(
      new Set((params.required as string[]) ?? []),
      new Set(["questions", "metadata"])
    );
    assert.ok(isObjectRecord(answers.additionalProperties));
    assert.equal(
      (answers.additionalProperties as Record<string, unknown>).format,
      undefined
    );
    assert.ok(!(params.required as string[]).includes("answers"));
    assert.ok(!(params.required as string[]).includes("annotations"));
    assert.equal(annotationValue.type, "object");
    assert.equal(annotationValue.additionalProperties, false);
    assert.deepEqual(
      new Set((annotationValue.required as string[]) ?? []),
      new Set(["preview", "notes"])
    );
    assert.equal(metadata.type, "object");
    assert.equal(metadata.additionalProperties, false);
    assert.deepEqual(
      new Set((metadata.required as string[]) ?? []),
      new Set(["source"])
    );
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
    const params = result.tools![0].parameters as Record<string, unknown>;
    const metadata = (params.properties as Record<string, Record<string, unknown>>)
      .metadata;
    const metadataValue = metadata.additionalProperties as Record<string, unknown>;

    assert.deepEqual(
      new Set((params.required as string[]) ?? []),
      new Set(["subject", "description", "activeForm"])
    );
    assert.equal(metadata.type, "object");
    assert.ok(isObjectRecord(metadata.additionalProperties));
    assert.equal(metadataValue.type, "object");
    assert.equal(metadataValue.additionalProperties, false);
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
    const params = result.tools![0].parameters;
    const url = (params.properties as Record<string, Record<string, unknown>>).url;
    assert.equal(url.type, "string");
    assert.equal(url.format, undefined);
    // required includes all keys
    assert.ok((params.required as string[]).includes("url"));
    assert.ok((params.required as string[]).includes("raw"));
    assert.equal(params.additionalProperties, false);
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
    const params = result.tools![0].parameters;
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
    const params = result.tools![0].parameters as Record<string, unknown>;

    assert.deepEqual(params.required, []);
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
    const params = result.tools![0].parameters;
    const annotations = (params.properties as Record<string, Record<string, unknown>>)
      .annotations;
    const nested = annotations.additionalProperties as Record<string, unknown>;
    const nestedProps = nested.properties as Record<string, Record<string, unknown>>;

    assert.equal(nestedProps.preview.format, undefined);
    assert.deepEqual(nested.required, ["preview", "label"]);
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
    // Should emit message_start but no text delta (reasoning is consumed silently)
    assert.ok(events.some((e) => e.includes("message_start")));
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
      assert.equal(mapModel("claude-opus-4-20250514"), "gpt-5.1-codex-max");
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
        "gpt-5.3-codex"
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
        "gpt-5.1-codex-mini"
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
    assert.ok(models["gpt-5.3-codex"]);
    assert.ok(models["gpt-5.1-codex-max"]);
    assert.ok(models["gpt-5.1-codex-mini"]);
    assert.equal(models["gpt-5.1-codex-max"].tier, "high");
    assert.equal(models["gpt-5.1-codex-mini"].tier, "fast");
  });
});
