/**
 * Logger module — structured console logging with levels and colors.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export function debug(msg: string, data?: Record<string, unknown>): void {
  if (currentLevel > LogLevel.DEBUG) return;
  const extra = data ? " " + JSON.stringify(data) : "";
  console.log(`\x1b[90m[${timestamp()}] DBG\x1b[0m ${msg}${extra}`);
}

export function info(msg: string, data?: Record<string, unknown>): void {
  if (currentLevel > LogLevel.INFO) return;
  const extra = data ? " " + JSON.stringify(data) : "";
  console.log(`\x1b[36m[${timestamp()}] INF\x1b[0m ${msg}${extra}`);
}

export function warn(msg: string, data?: Record<string, unknown>): void {
  if (currentLevel > LogLevel.WARN) return;
  const extra = data ? " " + JSON.stringify(data) : "";
  console.warn(`\x1b[33m[${timestamp()}] WRN\x1b[0m ${msg}${extra}`);
}

export function error(msg: string, data?: Record<string, unknown>): void {
  const extra = data ? " " + JSON.stringify(data) : "";
  console.error(`\x1b[31m[${timestamp()}] ERR\x1b[0m ${msg}${extra}`);
}

export function requestLog(
  model: string,
  estimatedTokens: number,
  status: string
): void {
  info(`[${model}] [~${estimatedTokens} tokens] [${status}]`);
}
