import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { collectCodexResponseFromSSE } from "../src/server.js";

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
});
