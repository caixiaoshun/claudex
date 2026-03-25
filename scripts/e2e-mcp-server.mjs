import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "claudex-e2e",
  version: "1.0.0",
});

server.registerTool(
  "echo_text",
  {
    title: "Echo Text",
    description:
      "Echo the provided text verbatim in the format MCP_TOOL_OK:<text>.",
    inputSchema: {
      text: z.string().describe("The text to echo back."),
    },
  },
  async ({ text }) => ({
    content: [
      {
        type: "text",
        text: `MCP_TOOL_OK:${text}`,
      },
    ],
  })
);

server.registerResource(
  "e2e-report",
  "e2e://report",
  {
    title: "Claudex E2E Report",
    description: "Static test resource used for live MCP compatibility checks.",
    mimeType: "text/plain",
  },
  async () => ({
    contents: [
      {
        uri: "e2e://report",
        text: "MCP_RESOURCE_OK",
      },
    ],
  })
);

server.registerPrompt(
  "sentinel_prompt",
  {
    title: "Sentinel Prompt",
    description: "Returns a prompt that asks for a deterministic MCP sentinel.",
    argsSchema: {
      topic: z.string().describe("Topic suffix for the sentinel."),
    },
  },
  async ({ topic }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Reply with exactly MCP_PROMPT_OK:${topic}`,
        },
      },
    ],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
