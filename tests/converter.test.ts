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
  type AnthropicRequest,
} from "../src/converter.js";
import { _resetForTesting, getModels } from "../src/models.js";

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
    assert.equal(result.input[0].role, "user");
    assert.equal(result.input[0].content, "Hello, world!");
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
    assert.equal(result.input[0].content, "Hello");
    assert.equal(result.input[1].role, "assistant");
    assert.equal(result.input[1].content, "Hi there!");
    assert.equal(result.input[2].content, "How are you?");
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
    const required = result.tools![0].parameters.required;
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

    // Assistant message should have text + function call
    assert.ok(result.input.length >= 2);
    const assistantMsg = result.input[0];
    assert.equal(assistantMsg.role, "assistant");

    // User message with tool result
    const toolResultMsg = result.input[1];
    assert.equal(toolResultMsg.role, "user");
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
