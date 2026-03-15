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
  // Treat as expired 60 seconds early to avoid edge cases
  return Date.now() >= session.expires_at - 60_000;
}

// ---------- External Session Sources ----------

export interface ExternalSource {
  name: string;
  path: string;
  session: SessionData;
}

/**
 * Known locations where Codex-compatible credentials may be stored.
 * 已知的存储 Codex 兼容凭证的位置。
 */
export const EXTERNAL_CANDIDATE_PATHS: Array<{
  name: string;
  filePath: string;
  parse: (raw: string) => SessionData | null;
}> = [
  {
    // OpenAI Codex CLI: ~/.codex/auth.json
    name: "OpenAI Codex CLI (~/.codex/auth.json)",
    filePath: path.join(os.homedir(), ".codex", "auth.json"),
    parse(raw) {
      try {
        const d = JSON.parse(raw) as Record<string, unknown>;
        // Codex CLI may store tokens at the top level or nested under a "tokens" key
        const src = (d.tokens as Record<string, unknown> | undefined) ?? d;
        // Codex CLI uses camelCase
        const accessToken = (src.accessToken ?? src.access_token) as string | undefined;
        const refreshToken = (src.refreshToken ?? src.refresh_token) as string | undefined;
        if (!accessToken || !refreshToken) {
          logger.debug("Codex CLI auth.json: missing accessToken or refreshToken", { keys: Object.keys(d) });
          return null;
        }

        // expiresAt may be a Unix timestamp (ms or s), ISO string, or "expires_in" (seconds from now)
        let expiresAt: number;
        const raw_exp = src.expiresAt ?? src.expires_at;
        const raw_exp_in = src.expiresIn ?? src.expires_in;
        if (typeof raw_exp === "number") {
          // If it looks like seconds (< year 3000 in ms would be ~32503680000000)
          expiresAt = raw_exp < 1e12 ? raw_exp * 1000 : raw_exp;
        } else if (typeof raw_exp === "string") {
          expiresAt = new Date(raw_exp).getTime();
        } else if (typeof raw_exp_in === "number") {
          expiresAt = Date.now() + raw_exp_in * 1000;
        } else {
          // Unknown — assume 1 hour from now so the refresh path is taken
          expiresAt = Date.now() + 3_600_000;
        }

        const accountId = (src.accountId ?? src.account_id) as string | undefined;
        return { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt, account_id: accountId };
      } catch (err) {
        logger.debug("Codex CLI auth.json: parse error", { error: String(err) });
        return null;
      }
    },
  },
  {
    // opencode: ~/.opencode/session.json (same CLIENT_ID, same token shape)
    name: "opencode (~/.opencode/session.json)",
    filePath: path.join(os.homedir(), ".opencode", "session.json"),
    parse(raw) {
      try {
        const d = JSON.parse(raw) as Record<string, unknown>;
        // opencode may nest under a "codex" key or store flat
        const src = (d.codex as Record<string, unknown> | undefined) ?? d;
        const accessToken = (src.access_token ?? src.accessToken) as string | undefined;
        const refreshToken = (src.refresh_token ?? src.refreshToken) as string | undefined;
        if (!accessToken || !refreshToken) return null;

        const raw_exp = src.expires_at ?? src.expiresAt;
        let expiresAt: number;
        if (typeof raw_exp === "number") {
          expiresAt = raw_exp < 1e12 ? raw_exp * 1000 : raw_exp;
        } else if (typeof raw_exp === "string") {
          expiresAt = new Date(raw_exp).getTime();
        } else {
          expiresAt = Date.now() + 3_600_000;
        }

        const accountId = (src.account_id ?? src.accountId) as string | undefined;
        return { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt, account_id: accountId };
      } catch {
        return null;
      }
    },
  },
  {
    // opencode v2 layout: ~/.opencode/auth/codex.json
    name: "opencode v2 (~/.opencode/auth/codex.json)",
    filePath: path.join(os.homedir(), ".opencode", "auth", "codex.json"),
    parse(raw) {
      try {
        const d = JSON.parse(raw) as Record<string, unknown>;
        const accessToken = (d.access_token ?? d.accessToken) as string | undefined;
        const refreshToken = (d.refresh_token ?? d.refreshToken) as string | undefined;
        if (!accessToken || !refreshToken) return null;

        const raw_exp = d.expires_at ?? d.expiresAt;
        let expiresAt: number;
        if (typeof raw_exp === "number") {
          expiresAt = raw_exp < 1e12 ? raw_exp * 1000 : raw_exp;
        } else if (typeof raw_exp === "string") {
          expiresAt = new Date(raw_exp).getTime();
        } else {
          expiresAt = Date.now() + 3_600_000;
        }

        const accountId = (d.account_id ?? d.accountId) as string | undefined;
        return { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt, account_id: accountId };
      } catch {
        return null;
      }
    },
  },
];

/**
 * Scan all known external credential locations and return the ones that exist and parse successfully.
 * 扫描所有已知的外部凭证位置，返回存在且可成功解析的条目。
 */
export function detectExternalSources(): ExternalSource[] {
  const found: ExternalSource[] = [];
  for (const candidate of EXTERNAL_CANDIDATE_PATHS) {
    logger.debug(`Checking external source: ${candidate.name}`, { path: candidate.filePath });
    if (!fs.existsSync(candidate.filePath)) {
      logger.debug(`  File does not exist, skipping: ${candidate.filePath}`);
      continue;
    }
    try {
      let raw = fs.readFileSync(candidate.filePath, "utf-8");
      // Strip UTF-8 BOM that Windows editors / tools may prepend
      if (raw.charCodeAt(0) === 0xfeff) {
        raw = raw.slice(1);
      }
      const session = candidate.parse(raw);
      if (session) {
        logger.debug(`  Successfully parsed credentials from: ${candidate.name}`);
        found.push({ name: candidate.name, path: candidate.filePath, session });
      } else {
        logger.debug(`  File exists but parse returned null (schema mismatch?): ${candidate.filePath}`);
      }
    } catch (err) {
      logger.debug(`  Failed to read file: ${candidate.filePath}`, { error: String(err) });
    }
  }
  return found;
}

/**
 * Import a session from an external source into our own session file.
 * 将外部来源的会话导入我们自己的会话文件。
 */
export function importExternalSession(source: ExternalSource): void {
  save(source.session);
  logger.info(`Imported session from: ${source.name}`);
}
