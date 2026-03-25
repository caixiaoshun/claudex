import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { collectCodexResponseFromSSE, startServer } from "../src/server.js";

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("collectCodexResponseFromSSE", () => {
  it("should return the embedded response from response.completed", async () => {
    const expected = {
      id: "resp_123",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    };

    const response = new Response(
      sseEvent("response.created", { type: "response.created" }) +
        sseEvent("response.completed", {
          type: "response.completed",
          response: expected,
        })
    );

    const result = await collectCodexResponseFromSSE(response);

    assert.deepEqual(result, expected);
  });

  it("should reconstruct a sync response when the SSE stream omits response.completed.response", async () => {
    const response = new Response(
      sseEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "Hel",
      }) +
        sseEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          delta: "lo",
        }) +
        sseEvent("response.output_text.done", {
          type: "response.output_text.done",
        }) +
        sseEvent("response.output_item.done", {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call_123",
            name: "DemoTool",
            arguments: "{\"ok\":true}",
          },
        }) +
        sseEvent("response.completed", {
          type: "response.completed",
          status: "completed",
          usage: { input_tokens: 7, output_tokens: 5 },
        })
    );

    const result = await collectCodexResponseFromSSE(response);

    assert.deepEqual(result, {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Hello" }],
        },
        {
          type: "function_call",
          call_id: "call_123",
          name: "DemoTool",
          arguments: "{\"ok\":true}",
        },
      ],
      usage: { input_tokens: 7, output_tokens: 5 },
      status: "completed",
    });
  });

  it("should reconstruct streamed function_call arguments emitted as delta events", async () => {
    const response = new Response(
      sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_call_123",
          call_id: "call_123",
          name: "DemoTool",
        },
      }) +
        sseEvent("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: "fc_call_123",
          output_index: 0,
          delta: '{"ok":',
        }) +
        sseEvent("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: "fc_call_123",
          output_index: 0,
          arguments: '{"ok":true}',
        }) +
        sseEvent("response.output_item.done", {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_call_123",
            call_id: "call_123",
            name: "DemoTool",
          },
        }) +
        sseEvent("response.completed", {
          type: "response.completed",
          status: "completed",
          usage: { input_tokens: 7, output_tokens: 5 },
        })
    );

    const result = await collectCodexResponseFromSSE(response);

    assert.deepEqual(result, {
      output: [
        {
          type: "function_call",
          call_id: "call_123",
          name: "DemoTool",
          arguments: '{"ok":true}',
        },
      ],
      usage: { input_tokens: 7, output_tokens: 5 },
      status: "completed",
    });
  });
});

describe("startServer", () => {
  it("should serve /v1/messages/count_tokens without requiring upstream auth", async () => {
    const server = startServer(0);
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/messages/count_tokens`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-3-5-sonnet-20241022",
            messages: [{ role: "user", content: "Hello world" }],
          }),
        }
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { input_tokens: 4 });
    } finally {
      server.close();
    }
  });
});
