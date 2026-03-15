#!/usr/bin/env node

/**
 * Claudex — CLI entry point
 * Bridge Claude Code to ChatGPT Codex via local proxy
 *
 * Claudex — CLI 入口
 * 通过本地代理将 Claude Code 桥接到 ChatGPT Codex
 */

import * as logger from "./logger.js";
import { LogLevel } from "./logger.js";
import * as oauth from "./oauth.js";
import * as token from "./token.js";
import { startServer } from "./server.js";
import { proxyConfig, CODEX_MODELS } from "./converter.js";

const DEFAULT_PORT = 4000;

function printBanner(): void {
  console.log(`
\x1b[36m   _____ _                 _
  / ____| |               | |
 | |    | | __ _ _   _  __| | _____  __
 | |    | |/ _\` | | | |/ _\` |/ _ \\ \\/ /
 | |____| | (_| | |_| | (_| |  __/>  <
  \\_____|_|\\__,_|\\__,_|\\__,_|\\___/_/\\_\\\x1b[0m

  \x1b[90mBridge Claude Code → ChatGPT Codex\x1b[0m
  \x1b[90mv1.0.0\x1b[0m
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  let reuseCodex = false;
  let listSources = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      if (isNaN(port)) {
        console.error("Invalid port number");
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--model" && args[i + 1]) {
      proxyConfig.model = args[i + 1];
      i++;
    } else if (args[i] === "--reasoning" && args[i + 1]) {
      const val = args[i + 1];
      if (!["low", "medium", "high"].includes(val)) {
        console.error("Invalid reasoning level. Must be low, medium, or high.");
        process.exit(1);
      }
      proxyConfig.reasoning = val as "low" | "medium" | "high";
      i++;
    } else if (args[i] === "--debug") {
      logger.setLogLevel(LogLevel.DEBUG);
    } else if (args[i] === "--reuse-codex") {
      reuseCodex = true;
    } else if (args[i] === "--list-sources") {
      listSources = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    } else if (args[i] === "--version" || args[i] === "-v") {
      console.log("1.0.0");
      process.exit(0);
    }
  }

  // --list-sources: show detected credential files and exit
  if (listSources) {
    handleListSources();
    process.exit(0);
  }

  printBanner();

  // --reuse-codex: import credentials from an existing Codex/opencode installation
  if (reuseCodex) {
    const imported = handleReuseCodex();
    if (!imported) {
      logger.warn(
        "No external credentials found. Falling back to OAuth browser flow."
      );
    }
  }

  // Step 1: Ensure OAuth session
  logger.info("Checking ChatGPT authorization...");
  try {
    await oauth.ensureSession();
    logger.info("✅ ChatGPT authorized successfully");
  } catch (err) {
    logger.error(
      `Authorization failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  // Step 2: Start proxy server
  const server = startServer(port);

  const modelDisplay = proxyConfig.model || "(auto-mapped from Claude Code model)";
  const reasoningDisplay = proxyConfig.reasoning || "(auto)";

  console.log(`
\x1b[32m✅ Proxy is ready!\x1b[0m

\x1b[33mModel:\x1b[0m      ${modelDisplay}
\x1b[33mReasoning:\x1b[0m  ${reasoningDisplay}

\x1b[33mConfigure Claude Code:\x1b[0m
  export ANTHROPIC_BASE_URL=http://localhost:${port}
  export ANTHROPIC_API_KEY=placeholder

\x1b[33mThen use Claude Code normally:\x1b[0m
  claude "Help me refactor this function"

\x1b[90mPress Ctrl+C to stop the proxy.\x1b[0m
`);

  const shutdown = () => {
    logger.info("Shutting down...");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Print all detected external credential sources to stdout.
 * 将所有检测到的外部凭证来源打印到 stdout。
 */
function handleListSources(): void {
  const sources = token.detectExternalSources();
  if (sources.length === 0) {
    console.log(
      "\x1b[33mNo external Codex credential sources found.\x1b[0m\n" +
        "Searched locations:\n" +
        "  ~/.codex/auth.json           (OpenAI Codex CLI)\n" +
        "  ~/.opencode/session.json     (opencode)\n" +
        "  ~/.opencode/auth/codex.json  (opencode v2)"
    );
    return;
  }

  console.log(
    `\x1b[32mFound ${sources.length} external credential source(s):\x1b[0m\n`
  );
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const expired = token.isExpired(s.session);
    const expiry = new Date(s.session.expires_at).toLocaleString();
    const statusLabel = expired
      ? "\x1b[33m(expired — refresh token will be used)\x1b[0m"
      : "\x1b[32m(valid)\x1b[0m";
    console.log(`  [${i + 1}] ${s.name}`);
    console.log(`      Path     : ${s.path}`);
    console.log(`      Expires  : ${expiry} ${statusLabel}`);
    if (s.session.account_id) {
      console.log(`      Account  : ${s.session.account_id}`);
    }
    console.log();
  }
  console.log(
    "Run \x1b[36mclaudex --reuse-codex\x1b[0m to automatically import the first valid source."
  );
}

/**
 * Attempt to import credentials from the first suitable external source.
 * Returns true if a source was successfully imported.
 *
 * 尝试从第一个合适的外部来源导入凭证。
 * 成功导入返回 true。
 */
function handleReuseCodex(): boolean {
  const sources = token.detectExternalSources();

  if (sources.length === 0) {
    return false;
  }

  // Prefer a non-expired source; fall back to the first one (refresh will handle it)
  const preferred =
    sources.find((s) => !token.isExpired(s.session)) ?? sources[0];

  logger.info(`Importing credentials from: ${preferred.name}`);
  logger.info(`  Path: ${preferred.path}`);
  if (token.isExpired(preferred.session)) {
    logger.info(
      "  Access token is expired — will use refresh token to obtain a new one."
    );
  }

  token.importExternalSession(preferred);
  return true;
}

function printHelp(): void {
  console.log(`
Claudex — Bridge Claude Code to ChatGPT Codex

Usage:
  claudex [options]

Options:
  -p, --port <port>           Port to listen on (default: 4000)
  --model <model>             Codex model to use (e.g. gpt-5.3-codex)
  --reasoning <low|medium|high>  Reasoning intensity level
  --reuse-codex               Import credentials from an existing Codex / opencode
                              installation instead of launching the browser OAuth flow.
                              Searches:
                                ~/.codex/auth.json           (OpenAI Codex CLI)
                                ~/.opencode/session.json     (opencode)
                                ~/.opencode/auth/codex.json  (opencode v2)
  --list-sources              List all detected external credential sources and exit.
  --debug                     Enable debug logging
  -h, --help                  Show this help message
  -v, --version               Show version

Environment Variables:
  CODEX_MODEL          Codex model to use (default: auto-mapped from Claude Code model)
  CODEX_REASONING      Reasoning intensity: low, medium, or high
  CODEX_API_ENDPOINT   Override Codex API endpoint
  PROXY_PORT           Default port (overridden by --port)

Model Selection:
  At startup:        claudex --model gpt-5.3-codex --reasoning high
  Via env:           CODEX_MODEL=gpt-5.3-codex CODEX_REASONING=high claudex
  At runtime:        curl -X POST http://localhost:4000/claudex/config \\
                       -d '{"model":"gpt-5.3-codex","reasoning":"high"}'
  Via /model in Claude Code:
                     Use the model name claudex:<codex-model>:<reasoning>
                     e.g. claudex:gpt-5.3-codex:high

Endpoints:
  POST /v1/messages      Anthropic Messages API proxy
  GET  /claudex/models   List available Codex models
  POST /claudex/config   Update runtime model/reasoning
  GET  /health           Health check

Examples:
  # First run — open browser for ChatGPT login
  claudex

  # Reuse credentials from an already-logged-in Codex CLI install
  claudex --reuse-codex

  # Use specific model and reasoning level
  claudex --model gpt-5.1-codex-max --reasoning high

  # See what credential files were detected on this machine
  claudex --list-sources
`);
}

main().catch((err) => {
  logger.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
