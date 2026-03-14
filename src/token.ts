/**
 * Token persistence module — stores OAuth session to ~/.codex-proxy/session.json
 * Token 持久化模块 — 将 OAuth 会话保存到 ~/.codex-proxy/session.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as logger from "./logger.js";

export interface SessionData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in milliseconds
  account_id?: string;
}

const SESSION_DIR = path.join(os.homedir(), ".codex-proxy");
const SESSION_FILE = path.join(SESSION_DIR, "session.json");

export function getSessionPath(): string {
  return SESSION_FILE;
}

export function load(): SessionData | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, "utf-8");
    const data = JSON.parse(raw) as SessionData;
    if (!data.access_token || !data.refresh_token) return null;
    return data;
  } catch {
    logger.warn("Failed to read session file, will re-authenticate");
    return null;
  }
}

export function save(data: SessionData): void {
  try {
    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });
    logger.debug("Session saved", { path: SESSION_FILE });
  } catch (err) {
    logger.error("Failed to save session", {
      error: String(err),
    });
  }
}

export function clear(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch {
    // Ignore
  }
}

export function isExpired(session: SessionData): boolean {
  return Date.now() >= session.expires_at;
}
