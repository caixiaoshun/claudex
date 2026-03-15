/**
 * Token persistence — stores OAuth session to ~/.codex-proxy/session.json
 * and detects external credential sources.
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
    logger.error("Failed to save session", { error: String(err) });
  }
}

export function clear(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch {
    // ignore
  }
}

export function isExpired(session: SessionData): boolean {
  return Date.now() >= session.expires_at - 60_000;
}

// ---------- External Credential Sources ----------

export interface ExternalSource {
  name: string;
  path: string;
  session: SessionData;
}

/** Parse a raw expiry value into ms-epoch. */
function parseExpiry(
  raw_exp: unknown,
  raw_exp_in: unknown
): number {
  if (typeof raw_exp === "number") {
    return raw_exp < 1e12 ? raw_exp * 1000 : raw_exp;
  }
  if (typeof raw_exp === "string") {
    return new Date(raw_exp).getTime();
  }
  if (typeof raw_exp_in === "number") {
    return Date.now() + raw_exp_in * 1000;
  }
  return Date.now() + 3_600_000;
}

export const EXTERNAL_CANDIDATE_PATHS: Array<{
  name: string;
  filePath: string;
  parse: (raw: string) => SessionData | null;
}> = [
  {
    name: "OpenAI Codex CLI (~/.codex/auth.json)",
    filePath: path.join(os.homedir(), ".codex", "auth.json"),
    parse(raw) {
      try {
        const d = JSON.parse(raw) as Record<string, unknown>;
        const src =
          (d.tokens as Record<string, unknown> | undefined) ?? d;
        const accessToken = (src.accessToken ?? src.access_token) as
          | string
          | undefined;
        const refreshToken = (src.refreshToken ?? src.refresh_token) as
          | string
          | undefined;
        if (!accessToken || !refreshToken) return null;
        const expiresAt = parseExpiry(
          src.expiresAt ?? src.expires_at,
          src.expiresIn ?? src.expires_in
        );
        const accountId = (src.accountId ?? src.account_id) as
          | string
          | undefined;
        return {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: expiresAt,
          account_id: accountId,
        };
      } catch {
        return null;
      }
    },
  },
  {
    name: "opencode (~/.opencode/session.json)",
    filePath: path.join(os.homedir(), ".opencode", "session.json"),
    parse(raw) {
      try {
        const d = JSON.parse(raw) as Record<string, unknown>;
        const src =
          (d.codex as Record<string, unknown> | undefined) ?? d;
        const accessToken = (src.access_token ?? src.accessToken) as
          | string
          | undefined;
        const refreshToken = (src.refresh_token ?? src.refreshToken) as
          | string
          | undefined;
        if (!accessToken || !refreshToken) return null;
        const expiresAt = parseExpiry(
          src.expires_at ?? src.expiresAt,
          src.expires_in ?? src.expiresIn
        );
        const accountId = (src.account_id ?? src.accountId) as
          | string
          | undefined;
        return {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: expiresAt,
          account_id: accountId,
        };
      } catch {
        return null;
      }
    },
  },
  {
    name: "opencode v2 (~/.opencode/auth/codex.json)",
    filePath: path.join(os.homedir(), ".opencode", "auth", "codex.json"),
    parse(raw) {
      try {
        const d = JSON.parse(raw) as Record<string, unknown>;
        const accessToken = (d.access_token ?? d.accessToken) as
          | string
          | undefined;
        const refreshToken = (d.refresh_token ?? d.refreshToken) as
          | string
          | undefined;
        if (!accessToken || !refreshToken) return null;
        const expiresAt = parseExpiry(
          d.expires_at ?? d.expiresAt,
          d.expires_in ?? d.expiresIn
        );
        const accountId = (d.account_id ?? d.accountId) as
          | string
          | undefined;
        return {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: expiresAt,
          account_id: accountId,
        };
      } catch {
        return null;
      }
    },
  },
];

export function detectExternalSources(): ExternalSource[] {
  const found: ExternalSource[] = [];
  for (const candidate of EXTERNAL_CANDIDATE_PATHS) {
    if (!fs.existsSync(candidate.filePath)) continue;
    try {
      let raw = fs.readFileSync(candidate.filePath, "utf-8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const session = candidate.parse(raw);
      if (session) {
        found.push({
          name: candidate.name,
          path: candidate.filePath,
          session,
        });
      }
    } catch {
      // skip unreadable files
    }
  }
  return found;
}

export function importExternalSession(source: ExternalSource): void {
  save(source.session);
  logger.info(`Imported session from: ${source.name}`);
}
