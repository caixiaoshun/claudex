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
import { startServer } from "./server.js";

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
  // Parse args
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      if (isNaN(port)) {
        console.error("Invalid port number");
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--debug") {
      logger.setLogLevel(LogLevel.DEBUG);
    } else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    } else if (args[i] === "--version" || args[i] === "-v") {
      console.log("1.0.0");
      process.exit(0);
    }
  }

  printBanner();

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

  // Print usage instructions
  console.log(`
\x1b[32m✅ Proxy is ready!\x1b[0m

\x1b[33mConfigure Claude Code:\x1b[0m
  export ANTHROPIC_BASE_URL=http://localhost:${port}
  export ANTHROPIC_API_KEY=placeholder

\x1b[33mThen use Claude Code normally:\x1b[0m
  claude "Help me refactor this function"

\x1b[90mPress Ctrl+C to stop the proxy.\x1b[0m
`);

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function printHelp(): void {
  console.log(`
Claudex — Bridge Claude Code to ChatGPT Codex

Usage:
  claudex [options]

Options:
  -p, --port <port>   Port to listen on (default: 4000)
  --debug             Enable debug logging
  -h, --help          Show this help message
  -v, --version       Show version

Environment Variables:
  CODEX_MODEL          Codex model to use (default: gpt-5.3-codex)
  CODEX_API_ENDPOINT   Override Codex API endpoint
  PROXY_PORT           Default port (overridden by --port)
`);
}

main().catch((err) => {
  logger.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
