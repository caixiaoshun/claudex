/**
 * HTTP proxy server — receives Anthropic format, forwards to Codex, returns Anthropic format
 * HTTP 代理服务器 — 接收 Anthropic 格式请求，转发到 Codex，返回 Anthropic 格式响应
 */

import * as http from "node:http";
import * as logger from "./logger.js";
import * as oauth from "./oauth.js";
import {
  anthropicToCodex,
  codexToAnthropic,
  buildErrorResponse,
  estimateRequestTokens,
  StreamConverter,
  CODEX_MODELS,
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

/**
 * Read the full request body as JSON.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Handle POST /v1/messages — the main proxy route.
 * 处理 POST /v1/messages — 主要的代理路由。
 */
async function handleMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let anthropicReq: AnthropicRequest;

  try {
    const body = await readBody(req);
    anthropicReq = JSON.parse(body) as AnthropicRequest;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildErrorResponse(400, "Invalid JSON body")));
    return;
  }

  const estimatedTokens = estimateRequestTokens(anthropicReq);
  const isStream = anthropicReq.stream === true;

  logger.requestLog(
    anthropicReq.model,
    estimatedTokens,
    isStream ? "stream" : "sync"
  );

  // Get valid session (refresh if needed)
  let session;
  try {
    session = await oauth.getValidSession();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Auth error", { error: msg });
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(buildErrorResponse(401, `Authentication failed: ${msg}`))
    );
    return;
  }

  // Convert request format
  const codexReq = anthropicToCodex(anthropicReq);

  // Build request headers matching what opencode sends
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
    const codexRes = await fetch(CODEX_API_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(codexReq),
    });

    if (!codexRes.ok) {
      const errorText = await codexRes.text().catch(() => "Unknown error");
      logger.error(`Codex API error: ${codexRes.status}`, {
        body: errorText.slice(0, 500),
      });
      logger.requestLog(anthropicReq.model, estimatedTokens, `error:${codexRes.status}`);

      const statusMap: Record<number, number> = {
        401: 401,
        403: 401,
        429: 429,
        500: 503,
      };
      const anthropicStatus = statusMap[codexRes.status] || 502;

      res.writeHead(anthropicStatus, { "Content-Type": "application/json" });
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
      await handleStreamResponse(codexRes, res, anthropicReq);
    } else {
      await handleSyncResponse(codexRes, res, anthropicReq);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Proxy error", { error: msg });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(buildErrorResponse(500, `Proxy error: ${msg}`))
    );
  }
}

/**
 * Handle non-streaming response.
 */
async function handleSyncResponse(
  codexRes: Response,
  res: http.ServerResponse,
  anthropicReq: AnthropicRequest
): Promise<void> {
  const body = await codexRes.json();
  const anthropicRes = codexToAnthropic(
    body as Record<string, unknown>,
    anthropicReq.model
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
 * Handle streaming response — convert Codex SSE to Anthropic SSE format.
 * 处理流式响应 — 将 Codex SSE 转换为 Anthropic SSE 格式。
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

  const converter = new StreamConverter(anthropicReq.model);

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
    let gotCompletion = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events (terminated by double newline)
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
          if (event === "response.completed") {
            gotCompletion = true;
          }
        } catch {
          logger.debug("Skipping unparseable SSE data", { raw: data.slice(0, 100) });
        }
      }
    }

    // Finalize if no proper completion event was received
    if (!gotCompletion) {
      const events = converter.finalize();
      for (const ev of events) res.write(ev);
    }

    logger.requestLog(
      anthropicReq.model,
      converter.getEstimatedTokens(),
      "ok:stream"
    );
  } catch (err) {
    logger.error("Stream error", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Try to send a final event so the client doesn't hang
    const events = converter.finalize();
    for (const ev of events) res.write(ev);
  }

  res.end();
}

/**
 * Parse a raw SSE event string into event type and data.
 */
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

/**
 * Start the proxy server on the given port.
 * 在指定端口启动代理服务器。
 */
export function startServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS headers for flexibility
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key, anthropic-version"
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
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      await handleMessages(req, res);
      return;
    }

    // Claudex: list available Codex models
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

    // Claudex: refresh model list at runtime
    if (url.pathname === "/claudex/models/refresh" && req.method === "POST") {
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

    // Claudex: update runtime configuration
    if (url.pathname === "/claudex/config" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const config = JSON.parse(body) as Record<string, unknown>;
        if (typeof config.model === "string") proxyConfig.model = config.model;
        if (
          typeof config.reasoning === "string" &&
          ["low", "medium", "high", ""].includes(config.reasoning)
        ) {
          proxyConfig.reasoning = config.reasoning as "" | "low" | "medium" | "high";
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
        res.end(JSON.stringify(buildErrorResponse(400, "Invalid JSON body")));
      }
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        buildErrorResponse(404, `Unknown route: ${req.method} ${url.pathname}`)
      )
    );
  });

  server.listen(port, () => {
    logger.info(`Claudex proxy server listening on http://localhost:${port}`);
    logger.info("Route: POST /v1/messages (Anthropic Messages API)");
    logger.info("Route: GET  /claudex/models");
    logger.info("Route: POST /claudex/models/refresh");
    logger.info("Route: POST /claudex/config");
    logger.info("Health: GET /health");
  });

  return server;
}
