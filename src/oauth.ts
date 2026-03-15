/**
 * OAuth module — ChatGPT Codex authorization via PKCE flow.
 * Concurrent-safe token refresh using a single in-flight promise.
 *
 * Reference: sst/opencode packages/opencode/src/plugin/codex.ts
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import * as logger from "./logger.js";
import * as token from "./token.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const OAUTH_PORT = 18457;

interface PkceCodes {
  verifier: string;
  challenge: string;
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

// ---------- Crypto ----------

function generateRandomString(length: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const result: string[] = [];
  for (let i = 0; i < length; i++) {
    result.push(chars[crypto.randomInt(chars.length)]);
  }
  return result.join("");
}

function base64UrlEncode(buffer: Buffer | Uint8Array): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43);
  const hash = crypto.createHash("sha256").update(verifier).digest();
  const challenge = base64UrlEncode(hash);
  return { verifier, challenge };
}

// ---------- JWT Parsing ----------

function parseJwtClaims(jwtToken: string): IdTokenClaims | undefined {
  const parts = jwtToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return undefined;
  }
}

function extractAccountIdFromClaims(
  claims: IdTokenClaims
): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    const accountId = claims && extractAccountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token);
    return claims ? extractAccountIdFromClaims(claims) : undefined;
  }
  return undefined;
}

// ---------- Token Exchange ----------

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: pkce.verifier,
      }).toString(),
    });
  } catch (err) {
    throw new Error(
      `Token exchange fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Token exchange failed: ${response.status} ${text}`
    );
  }
  return response.json() as Promise<TokenResponse>;
}

async function doRefreshAccessToken(
  refreshToken: string
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
    });
  } catch (err) {
    throw new Error(
      `Token refresh fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Token refresh failed: ${response.status} ${text}`
    );
  }
  return response.json() as Promise<TokenResponse>;
}

// ---------- Concurrent-safe refresh ----------

let inflightRefresh: Promise<token.SessionData> | null = null;

/**
 * Refresh the access token, coalescing concurrent callers into a single
 * in-flight request so simultaneous expired-token hits don't trigger
 * multiple refreshes.
 */
export async function refreshAccessToken(
  refreshToken: string,
  existingAccountId?: string
): Promise<token.SessionData> {
  if (inflightRefresh) return inflightRefresh;

  inflightRefresh = (async () => {
    try {
      const tokens = await doRefreshAccessToken(refreshToken);
      const accountId =
        extractAccountId(tokens) || existingAccountId;
      const session: token.SessionData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at:
          Date.now() + (tokens.expires_in ?? 3600) * 1000,
        account_id: accountId,
      };
      token.save(session);
      return session;
    } finally {
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

// ---------- OAuth HTML ----------

const HTML_SUCCESS = `<!doctype html>
<html>
<head><title>Claudex - Authorization Successful</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0d1117;color:#e6edf3}
.container{text-align:center;padding:2rem}
h1{color:#58a6ff;margin-bottom:1rem}
p{color:#8b949e}
</style></head>
<body><div class="container">
<h1>✅ Authorization Successful</h1>
<p>You can close this window and return to your terminal.</p>
</div>
<script>setTimeout(()=>window.close(),2000)</script>
</body></html>`;

const htmlError = (error: string) => `<!doctype html>
<html>
<head><title>Claudex - Authorization Failed</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0d1117;color:#e6edf3}
.container{text-align:center;padding:2rem}
h1{color:#f85149;margin-bottom:1rem}
p{color:#8b949e}
.error{color:#ffa198;font-family:monospace;margin-top:1rem;padding:1rem;background:#3c1414;border-radius:.5rem}
</style></head>
<body><div class="container">
<h1>❌ Authorization Failed</h1>
<p>An error occurred during authorization.</p>
<div class="error">${error}</div>
</div></body></html>`;

// ---------- OAuth Browser Flow ----------

export async function authorize(): Promise<token.SessionData> {
  const pkce = await generatePKCE();
  const state = generateState();
  const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`;
  const authUrl = buildAuthorizeUrl(redirectUri, pkce, state);

  return new Promise<token.SessionData>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(
        new Error("OAuth timeout - authorization took too long (5 min)")
      );
    }, 5 * 60 * 1000);

    const server = http.createServer(async (req, res) => {
      const url = new URL(
        req.url || "/",
        `http://localhost:${OAUTH_PORT}`
      );

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get(
          "error_description"
        );

        if (error) {
          const msg = errorDescription || error;
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(htmlError(msg));
          clearTimeout(timeout);
          server.close();
          reject(new Error(msg));
          return;
        }

        if (!code) {
          const msg = "Missing authorization code";
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(htmlError(msg));
          clearTimeout(timeout);
          server.close();
          reject(new Error(msg));
          return;
        }

        if (returnedState !== state) {
          const msg = "Invalid state - potential CSRF attack";
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(htmlError(msg));
          clearTimeout(timeout);
          server.close();
          reject(new Error(msg));
          return;
        }

        try {
          const tokens = await exchangeCodeForTokens(
            code,
            redirectUri,
            pkce
          );
          const accountId = extractAccountId(tokens);
          const session: token.SessionData = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at:
              Date.now() + (tokens.expires_in ?? 3600) * 1000,
            account_id: accountId,
          };
          token.save(session);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(HTML_SUCCESS);
          clearTimeout(timeout);
          server.close();
          resolve(session);
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : String(err);
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(htmlError(msg));
          clearTimeout(timeout);
          server.close();
          reject(err);
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    server.listen(OAUTH_PORT, () => {
      logger.info(
        `OAuth callback server listening on port ${OAUTH_PORT}`
      );
      logger.info(
        "Opening browser for ChatGPT authorization..."
      );
      logger.info(`If browser doesn't open, visit: ${authUrl}`);
      openBrowser(authUrl);
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Failed to start OAuth server on port ${OAUTH_PORT}: ${err.message}`
        )
      );
    });
  });
}

function buildAuthorizeUrl(
  redirectUri: string,
  pkce: PkceCodes,
  state: string
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex-cli",
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

// ---------- Session Management ----------

export async function ensureSession(): Promise<token.SessionData> {
  let session = token.load();

  if (session && !token.isExpired(session)) {
    logger.debug("Using cached session (valid)");
    return session;
  }

  if (session && session.refresh_token) {
    try {
      logger.info("Session expired, refreshing token...");
      const refreshed = await refreshAccessToken(
        session.refresh_token,
        session.account_id
      );
      logger.info("Token refreshed successfully");
      return refreshed;
    } catch (err) {
      logger.warn(
        `Token refresh failed: ${err instanceof Error ? err.message : String(err)}, re-authorizing...`
      );
    }
  }

  logger.info("No valid session found, starting OAuth flow...");
  return authorize();
}

export async function getValidSession(): Promise<token.SessionData> {
  const session = token.load();
  if (!session) {
    throw new Error(
      "No session found. Please restart the proxy to re-authorize."
    );
  }

  if (token.isExpired(session)) {
    logger.info("Access token expired, refreshing...");
    try {
      const refreshed = await refreshAccessToken(
        session.refresh_token,
        session.account_id
      );
      logger.info("Token refreshed successfully");
      return refreshed;
    } catch {
      throw new Error(
        "Token refresh failed. Please restart the proxy to re-authorize."
      );
    }
  }

  return session;
}

// ---------- Utility ----------

function openBrowser(url: string): void {
  const {
    exec,
  } = require("node:child_process") as typeof import("node:child_process");
  const platform = process.platform;
  let cmd: string;
  if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err: Error | null) => {
    if (err) {
      logger.warn(
        "Could not open browser automatically. Please open the URL manually."
      );
    }
  });
}
