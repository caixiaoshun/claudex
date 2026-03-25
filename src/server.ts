/**
 * HTTP proxy server — receives Anthropic format, forwards to Codex, returns Anthropic format.
 */

import * as http from "node:http";
import * as logger from "./logger.js";
import * as oauth from "./oauth.js";
import { applyClaudeSessionFallback } from "./claude-session-bridge.js";
import {
  anthropicToCodex,
  codexToAnthropic,
  buildErrorResponse,
  estimateRequestTokens,
  StreamConverter,
  proxyConfig,
  type AnthropicRequest,
} from "./converter.js";
import {
  getModels,
  getLastFetchTime,
  getTierMapping,
  refreshModels,
} from "./models.js";

const CODEX_API_ENDPOINT =
  process.env.CODEX_API_ENDPOINT ||
  "https://chatgpt.com/backend-api/codex/responses";
const CODEX_API_FETCH_RETRIES = Math.max(
  1,
  Number.parseInt(process.env.CODEX_API_FETCH_RETRIES || "3", 10) || 3
);
const CODEX_API_FETCH_RETRY_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.CODEX_API_FETCH_RETRY_DELAY_MS || "1000", 10) ||
    1000
);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function extractSchemaErrorToolName(errorText: string): string | null {
  const match = errorText.match(/function '([^']+)'/);
  return match ? match[1] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCodexWithRetries(
  url: string,
  init: RequestInit
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= CODEX_API_FETCH_RETRIES; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt >= CODEX_API_FETCH_RETRIES) {
        break;
      }

      logger.warn("Codex API fetch failed, retrying", {
        attempt,
        retries: CODEX_API_FETCH_RETRIES,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(CODEX_API_FETCH_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function logSchemaForTool(
  toolName: string,
  anthropicReq: AnthropicRequest,
  codexReq: ReturnType<typeof anthropicToCodex>
): void {
  if (Array.isArray(anthropicReq.tools)) {
    const incomingTool = anthropicReq.tools.find((tool) => tool.name === toolName);
    if (incomingTool) {
      logger.debug("Incoming tool schema for failed tool", {
        name: incomingTool.name,
        input_schema: incomingTool.input_schema,
      });
    }
  }

  if (Array.isArray(codexReq.tools)) {
    const convertedTool = codexReq.tools.find(
      (tool) => tool.type === "function" && tool.name === toolName
    );
    if (convertedTool) {
      logger.debug("Converted tool schema for failed tool", {
        name: convertedTool.name,
        parameters: convertedTool.parameters,
      });
    }
  }
}

/**
 * Handle POST /v1/messages — main proxy route.
 */
async function handleMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let anthropicReq: AnthropicRequest;
  let effectiveReq: AnthropicRequest;

  try {
    const body = await readBody(req);
    anthropicReq = JSON.parse(body) as AnthropicRequest;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildErrorResponse(400, "Invalid JSON body")));
    return;
  }

  try {
    effectiveReq = await applyClaudeSessionFallback(anthropicReq);
  } catch (error) {
    logger.warn("Claude session fallback failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    effectiveReq = anthropicReq;
  }

  const estimatedTokens = estimateRequestTokens(effectiveReq);
  const isStream = effectiveReq.stream === true;
  const systemSummaries = Array.isArray(effectiveReq.system)
    ? effectiveReq.system.map((block) => ({
        type: block.type,
        preview:
          typeof block.text === "string"
            ? block.text.length > 2000
              ? `${block.text.slice(0, 2000)}...`
              : block.text
            : undefined,
      }))
    : typeof effectiveReq.system === "string"
      ? [
          {
            type: "text",
            preview:
              effectiveReq.system.length > 2000
                ? `${effectiveReq.system.slice(0, 2000)}...`
                : effectiveReq.system,
          },
        ]
      : [];
  const messageSummaries = effectiveReq.messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? "string"
        : message.content.map((block) =>
            block.type === "text"
              ? {
                  type: "text",
                  preview:
                    block.text.length > 2000
                      ? `${block.text.slice(0, 2000)}...`
                      : block.text,
                }
              : block.type
          ),
  }));
  const extraRequestKeys = Object.keys(effectiveReq).filter(
    (key) =>
      ![
        "model",
        "max_tokens",
        "messages",
        "system",
        "tools",
        "stream",
        "temperature",
        "top_p",
        "stop_sequences",
        "betas",
        "metadata",
        "thinking",
        "output_config",
        "stream_options",
        "max_output_tokens",
        "tool_choice",
      ].includes(key)
  );

  logger.requestLog(
    effectiveReq.model,
    estimatedTokens,
    isStream ? "stream" : "sync"
  );
  logger.debug("Anthropic request summary", {
    originalMessageCount: anthropicReq.messages.length,
    messageCount: effectiveReq.messages.length,
    toolCount: Array.isArray(effectiveReq.tools) ? effectiveReq.tools.length : 0,
    systemType:
      typeof effectiveReq.system === "string"
        ? "string"
        : Array.isArray(effectiveReq.system)
          ? "array"
          : "none",
    systemSummaries,
    messageSummaries,
    extraRequestKeys,
    contextManagement:
      "context_management" in effectiveReq
        ? effectiveReq.context_management
        : undefined,
    requestHeaders: req.headers,
  });

  // Get valid session (refresh if needed)
  let session;
  try {
    session = await oauth.getValidSession();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Auth error", { error: msg });
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        buildErrorResponse(401, `Authentication failed: ${msg}`)
      )
    );
    return;
  }

  // Convert request format. Codex now requires stream=true even when the
  // Anthropic client asked for a sync response, so the proxy always talks to
  // Codex over SSE and aggregates back to JSON when needed.
  const codexReq = {
    ...anthropicToCodex(effectiveReq),
    stream: true,
  };

  logger.debug("Resolved model mapping", {
    anthropicModel: effectiveReq.model,
    codexModel: codexReq.model,
    reasoning:
      isRecord(codexReq.reasoning) && typeof codexReq.reasoning.effort === "string"
        ? codexReq.reasoning.effort
        : null,
  });

  const schemaDebugTools = new Set([
    "AskUserQuestion",
    "ExitPlanMode",
    "TaskCreate",
    "TaskUpdate",
    "Task",
  ]);
  if (Array.isArray(effectiveReq.tools)) {
    const incomingTools = effectiveReq.tools
      .filter(
        (tool) =>
          typeof tool.name === "string" && schemaDebugTools.has(tool.name)
      )
      .map((tool) => ({
        name: tool.name,
        input_schema: tool.input_schema,
      }));
    if (incomingTools.length > 0) {
      logger.debug("Incoming tool schemas", { tools: incomingTools });
    }
  }

  if (Array.isArray(codexReq.tools)) {
    const convertedTools = codexReq.tools
      .filter(
        (tool) =>
          tool.type === "function" &&
          typeof tool.name === "string" &&
          schemaDebugTools.has(tool.name)
      )
      .map((tool) => ({
        name: tool.name,
        parameters: tool.parameters,
      }));
    if (convertedTools.length > 0) {
      logger.debug("Converted tool schemas", { tools: convertedTools });
    }
  }

  // Build headers matching opencode's pattern
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.access_token}`,
    "User-Agent": `claudex/1.0.0 (${process.platform} ${process.arch})`,
    originator: "codex-cli",
  };
  if (session.account_id) {
    headers["ChatGPT-Account-Id"] = session.account_id;
  }

  try {
    let codexRes: Response;
    try {
      codexRes = await fetchCodexWithRetries(CODEX_API_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(codexReq),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Codex API fetch failed", { error: msg });
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          buildErrorResponse(502, `Codex API unreachable: ${msg}`)
        )
      );
      return;
    }

    if (!codexRes.ok) {
      const errorText = await codexRes.text().catch(() => "Unknown error");
      const failedToolName = extractSchemaErrorToolName(errorText);
      logger.error(`Codex API error: ${codexRes.status}`, {
        body: errorText.slice(0, 500),
      });
      if (failedToolName) {
        logSchemaForTool(failedToolName, anthropicReq, codexReq);
      }
      logger.requestLog(
        effectiveReq.model,
        estimatedTokens,
        `error:${codexRes.status}`
      );

      const statusMap: Record<number, number> = {
        401: 401,
        403: 401,
        429: 429,
        500: 503,
      };
      const anthropicStatus = statusMap[codexRes.status] || 502;

      res.writeHead(anthropicStatus, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify(
          buildErrorResponse(
            anthropicStatus,
            `Codex API error (${codexRes.status}): ${errorText.slice(0, 200)}`
          )
        )
      );
      return;
    }

    if (isStream) {
      await handleStreamResponse(codexRes, res, effectiveReq);
    } else {
      await handleSyncResponse(codexRes, res, effectiveReq);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Proxy error", { error: msg });
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify(buildErrorResponse(500, `Proxy error: ${msg}`))
    );
  }
}

async function handleCountTokens(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    const body = await readBody(req);
    const anthropicReq = JSON.parse(body) as AnthropicRequest;
    const effectiveReq = await applyClaudeSessionFallback(anthropicReq);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        input_tokens: estimateRequestTokens(effectiveReq),
      })
    );
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildErrorResponse(400, "Invalid JSON body")));
  }
}

async function handleSyncResponse(
  codexRes: Response,
  res: http.ServerResponse,
  anthropicReq: AnthropicRequest
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await collectCodexResponseFromSSE(codexRes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Failed to parse Codex response", { error: msg });
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        buildErrorResponse(502, `Failed to parse Codex response: ${msg}`)
      )
    );
    return;
  }

  const anthropicRes = codexToAnthropic(
    body,
    anthropicReq.model,
    anthropicReq.tools
  );

  logger.requestLog(
    anthropicReq.model,
    anthropicRes.usage.input_tokens + anthropicRes.usage.output_tokens,
    "ok"
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(anthropicRes));
}

/**
 * Handle streaming response — convert Codex SSE → Anthropic SSE.
 */
async function handleStreamResponse(
  codexRes: Response,
  res: http.ServerResponse,
  anthropicReq: AnthropicRequest
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const converter = new StreamConverter(
    anthropicReq.model,
    anthropicReq.tools
  );

  try {
    const reader = codexRes.body?.getReader();
    if (!reader) {
      const events = converter.finalize();
      for (const ev of events) res.write(ev);
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      let readResult: { done: boolean; value?: Uint8Array };
      try {
        readResult = await reader.read();
      } catch (err) {
        logger.error("Stream read error", {
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }

      const { done, value } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        if (!part.trim()) continue;

        const { event, data } = parseSSEEvent(part);
        if (!data) continue;

        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const events = converter.processEvent(event, parsed);
          for (const ev of events) {
            res.write(ev);
          }
        } catch {
          logger.debug("Skipping unparseable SSE data", {
            raw: data.slice(0, 100),
          });
        }
      }
    }

    // Finalize if converter hasn't finished
    const finalEvents = converter.finalize();
    for (const ev of finalEvents) res.write(ev);

    logger.requestLog(
      anthropicReq.model,
      converter.getEstimatedTokens(),
      "ok:stream"
    );
  } catch (err) {
    logger.error("Stream error", {
      error: err instanceof Error ? err.message : String(err),
    });
    const events = converter.finalize();
    for (const ev of events) res.write(ev);
  }

  res.end();
}

function parseSSEEvent(raw: string): { event: string; data: string | null } {
  let event = "";
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      const d = line.slice(5).trim();
      if (d === "[DONE]") continue;
      dataLines.push(d);
    }
  }

  return {
    event,
    data: dataLines.length > 0 ? dataLines.join("\n") : null,
  };
}

export async function collectCodexResponseFromSSE(
  codexRes: Response
): Promise<Record<string, unknown>> {
  const reader = codexRes.body?.getReader();
  if (!reader) {
    return {};
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: Record<string, unknown> | null = null;
  let currentText = "";
  let currentThinking = "";
  const fallbackOutput: Array<Record<string, unknown>> = [];
  let usage: Record<string, unknown> | undefined;
  let status = "completed";

  interface PendingFunctionCall {
    itemId?: string;
    outputIndex?: number;
    call_id: string;
    name: string;
    arguments: string;
    hadArgumentsDelta: boolean;
  }

  const pendingByItemId = new Map<string, PendingFunctionCall>();
  const pendingByOutputIndex = new Map<number, PendingFunctionCall>();

  const rememberPending = (call: PendingFunctionCall): void => {
    if (call.itemId) {
      pendingByItemId.set(call.itemId, call);
    }
    if (call.outputIndex !== undefined) {
      pendingByOutputIndex.set(call.outputIndex, call);
    }
  };

  const forgetPending = (call: PendingFunctionCall): void => {
    if (call.itemId) {
      pendingByItemId.delete(call.itemId);
    }
    if (call.outputIndex !== undefined) {
      pendingByOutputIndex.delete(call.outputIndex);
    }
  };

  const findPending = (parsed: Record<string, unknown>): PendingFunctionCall | null => {
    const itemId = typeof parsed.item_id === "string" ? parsed.item_id : undefined;
    if (itemId && pendingByItemId.has(itemId)) {
      return pendingByItemId.get(itemId) ?? null;
    }

    const outputIndex =
      typeof parsed.output_index === "number" ? parsed.output_index : undefined;
    if (
      outputIndex !== undefined &&
      pendingByOutputIndex.has(outputIndex)
    ) {
      return pendingByOutputIndex.get(outputIndex) ?? null;
    }

    if (pendingByItemId.size === 1) {
      return pendingByItemId.values().next().value ?? null;
    }

    if (pendingByOutputIndex.size === 1) {
      return pendingByOutputIndex.values().next().value ?? null;
    }

    return null;
  };

  const flushText = (): void => {
    if (!currentText) {
      return;
    }

    fallbackOutput.push({
      type: "message",
      content: [{ type: "output_text", text: currentText }],
    });
    currentText = "";
  };

  const flushThinking = (): void => {
    if (!currentThinking) {
      return;
    }

    fallbackOutput.push({
      type: "reasoning",
      summary: [{ text: currentThinking }],
    });
    currentThinking = "";
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      if (!part.trim()) {
        continue;
      }

      const { event, data } = parseSSEEvent(part);
      if (!data) {
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        logger.debug("Skipping unparseable sync SSE data", {
          raw: data.slice(0, 100),
        });
        continue;
      }

      const response = isRecord(parsed.response) ? parsed.response : null;
      if (response) {
        finalResponse = response;
      }

      switch (event) {
        case "response.output_text.delta":
          if (typeof parsed.delta === "string") {
            currentText += parsed.delta;
          }
          break;

        case "response.output_text.done": {
          if (!currentText && typeof parsed.text === "string") {
            currentText = parsed.text;
          }
          flushText();
          break;
        }

        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (typeof parsed.delta === "string") {
            currentThinking += parsed.delta;
          }
          break;

        case "response.reasoning_summary_part.done":
          flushThinking();
          break;

        case "response.output_item.added": {
          const item = isRecord(parsed.item) ? parsed.item : parsed;
          if (item.type === "function_call") {
            rememberPending({
              itemId: typeof item.id === "string" ? item.id : undefined,
              outputIndex:
                typeof parsed.output_index === "number"
                  ? parsed.output_index
                  : undefined,
              call_id:
                (item.call_id as string) ||
                (item.id as string) ||
                "",
              name: (item.name as string) || "unknown",
              arguments:
                typeof item.arguments === "string" ? item.arguments : "",
              hadArgumentsDelta: false,
            });
          }
          break;
        }

        case "response.function_call_arguments.delta": {
          const pending = findPending(parsed);
          if (pending && typeof parsed.delta === "string") {
            pending.arguments += parsed.delta;
            pending.hadArgumentsDelta = true;
          }
          break;
        }

        case "response.function_call_arguments.done": {
          const pending = findPending(parsed);
          if (
            pending &&
            typeof parsed.arguments === "string"
          ) {
            pending.arguments = parsed.arguments;
          }
          break;
        }

        case "response.output_item.done": {
          flushThinking();
          flushText();
          const item = isRecord(parsed.item) ? parsed.item : parsed;
          if (item.type === "function_call") {
            const pending =
              findPending(parsed) ??
              ({
                call_id:
                  (item.call_id as string) ||
                  (item.id as string) ||
                  "",
                name: (item.name as string) || "unknown",
                arguments:
                  typeof item.arguments === "string"
                    ? item.arguments
                    : "",
                hadArgumentsDelta: false,
              } as PendingFunctionCall);
            if (
              !pending.hadArgumentsDelta &&
              typeof item.arguments === "string" &&
              item.arguments
            ) {
              pending.arguments = item.arguments;
            }
            fallbackOutput.push({
              type: "function_call",
              call_id: pending.call_id,
              name: pending.name,
              arguments: pending.arguments,
            });
            forgetPending(pending);
          }
          break;
        }

        case "response.completed":
          if (!response && Array.isArray(parsed.output)) {
            finalResponse = {
              output: parsed.output,
              usage: isRecord(parsed.usage)
                ? parsed.usage
                : usage ?? { input_tokens: 0, output_tokens: 0 },
              status:
                typeof parsed.status === "string"
                  ? parsed.status
                  : "completed",
            };
          }
          usage = isRecord(response?.usage)
            ? response.usage
            : isRecord(parsed.usage)
              ? parsed.usage
              : usage;
          status =
            typeof response?.status === "string"
              ? response.status
              : typeof parsed.status === "string"
                ? parsed.status
                : "completed";
          break;

        case "response.incomplete":
          usage = isRecord(response?.usage)
            ? response.usage
            : isRecord(parsed.usage)
              ? parsed.usage
              : usage;
          status = "incomplete";
          break;

        case "response.failed":
          usage = isRecord(response?.usage)
            ? response.usage
            : isRecord(parsed.usage)
              ? parsed.usage
              : usage;
          status = "failed";
          break;
      }
    }
  }

  if (finalResponse) {
    return finalResponse;
  }

  flushThinking();
  flushText();

  return {
    output:
      fallbackOutput.length > 0
        ? fallbackOutput
        : [{ type: "message", content: [{ type: "output_text", text: "" }] }],
    usage: usage ?? { input_tokens: 0, output_tokens: 0 },
    status,
  };
}

/**
 * Start the proxy server.
 */
export function startServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta"
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // Health check
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Main proxy route
    if (
      url.pathname === "/v1/messages/count_tokens" &&
      req.method === "POST"
    ) {
      await handleCountTokens(req, res);
      return;
    }

    // Main proxy route
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      await handleMessages(req, res);
      return;
    }

    // List available Codex models
    if (url.pathname === "/claudex/models" && req.method === "GET") {
      const models = getModels();
      const tierMapping = getTierMapping();
      const lastFetch = getLastFetchTime();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          models,
          tier_mapping: tierMapping,
          last_fetched: lastFetch
            ? new Date(lastFetch).toISOString()
            : null,
        })
      );
      return;
    }

    // Refresh model list
    if (
      url.pathname === "/claudex/models/refresh" &&
      req.method === "POST"
    ) {
      try {
        const session = await oauth.getValidSession();
        const success = await refreshModels(
          session.access_token,
          session.account_id
        );
        const models = getModels();
        const tierMapping = getTierMapping();
        res.writeHead(success ? 200 : 503, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify({
            success,
            models,
            tier_mapping: tierMapping,
            last_fetched: new Date(getLastFetchTime()).toISOString(),
          })
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            buildErrorResponse(500, `Model refresh failed: ${msg}`)
          )
        );
      }
      return;
    }

    // Update runtime configuration
    if (url.pathname === "/claudex/config" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const config = JSON.parse(body) as Record<string, unknown>;
        if (typeof config.model === "string")
          proxyConfig.model = config.model;
        if (
          typeof config.reasoning === "string" &&
          ["low", "medium", "high", ""].includes(config.reasoning)
        ) {
          proxyConfig.reasoning = config.reasoning as
            | ""
            | "low"
            | "medium"
            | "high";
        }
        logger.info("Runtime config updated", {
          model: proxyConfig.model || "(auto)",
          reasoning: proxyConfig.reasoning || "(auto)",
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: proxyConfig.model || "(auto)",
            reasoning: proxyConfig.reasoning || "(auto)",
          })
        );
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(buildErrorResponse(400, "Invalid JSON body"))
        );
      }
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        buildErrorResponse(
          404,
          `Unknown route: ${req.method} ${url.pathname}`
        )
      )
    );
  });

  server.listen(port, () => {
    logger.info(
      `Claudex proxy server listening on http://localhost:${port}`
    );
    logger.info("Route: POST /v1/messages/count_tokens");
    logger.info("Route: POST /v1/messages (Anthropic Messages API)");
    logger.info("Route: GET  /claudex/models");
    logger.info("Route: POST /claudex/models/refresh");
    logger.info("Route: POST /claudex/config");
    logger.info("Health: GET /health");
  });

  return server;
}
