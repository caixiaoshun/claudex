/**
 * Unit tests for token credential parsing
 * Token 凭证解析的单元测试
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { EXTERNAL_CANDIDATE_PATHS, type SessionData } from "../src/token.js";

// Helper: grab the parse function for a given source by name prefix
function getParser(prefix: string): (raw: string) => SessionData | null {
  const entry = EXTERNAL_CANDIDATE_PATHS.find((c) => c.name.startsWith(prefix));
  if (!entry) throw new Error(`No candidate found with prefix "${prefix}"`);
  return entry.parse;
}

// ---------- Codex CLI parser ----------

describe("Codex CLI auth.json parser", () => {
  const parse = getParser("OpenAI Codex CLI");

  it("should parse flat camelCase format", () => {
    const raw = JSON.stringify({
      accessToken: "tok_abc",
      refreshToken: "ref_xyz",
      expiresAt: Date.now() + 3_600_000,
      accountId: "acct_1",
    });
    const result = parse(raw);
    assert.ok(result);
    assert.equal(result.access_token, "tok_abc");
    assert.equal(result.refresh_token, "ref_xyz");
    assert.equal(result.account_id, "acct_1");
  });

  it("should parse flat snake_case format", () => {
    const raw = JSON.stringify({
      access_token: "tok_abc",
      refresh_token: "ref_xyz",
      expires_at: 1700000000,
    });
    const result = parse(raw);
    assert.ok(result);
    assert.equal(result.access_token, "tok_abc");
    assert.equal(result.refresh_token, "ref_xyz");
    // 1700000000 < 1e12 → treated as seconds, multiplied by 1000
    assert.equal(result.expires_at, 1700000000000);
  });

  it("should parse nested tokens key (Windows Codex CLI schema)", () => {
    const raw = JSON.stringify({
      tokens: {
        access_token: "tok_win",
        refresh_token: "ref_win",
        expires_at: "2026-01-01T00:00:00Z",
      },
    });
    const result = parse(raw);
    assert.ok(result);
    assert.equal(result.access_token, "tok_win");
    assert.equal(result.refresh_token, "ref_win");
    assert.equal(result.expires_at, new Date("2026-01-01T00:00:00Z").getTime());
  });

  it("should handle expires_in instead of expires_at", () => {
    const before = Date.now();
    const raw = JSON.stringify({
      access_token: "tok_exp",
      refresh_token: "ref_exp",
      expires_in: 7200,
    });
    const result = parse(raw);
    const after = Date.now();
    assert.ok(result);
    assert.equal(result.access_token, "tok_exp");
    // expires_at should be ~now + 7200*1000
    assert.ok(result.expires_at >= before + 7200 * 1000);
    assert.ok(result.expires_at <= after + 7200 * 1000);
  });

  it("should handle ISO string expires_at", () => {
    const raw = JSON.stringify({
      accessToken: "tok_iso",
      refreshToken: "ref_iso",
      expiresAt: "2025-12-31T23:59:59.000Z",
    });
    const result = parse(raw);
    assert.ok(result);
    assert.equal(result.expires_at, new Date("2025-12-31T23:59:59.000Z").getTime());
  });

  it("should return null for missing access token", () => {
    const raw = JSON.stringify({ refresh_token: "ref_only" });
    assert.equal(parse(raw), null);
  });

  it("should return null for missing refresh token", () => {
    const raw = JSON.stringify({ access_token: "tok_only" });
    assert.equal(parse(raw), null);
  });

  it("should return null for invalid JSON", () => {
    assert.equal(parse("{bad json}"), null);
  });

  it("should handle BOM-free content with nested tokens and camelCase", () => {
    const raw = JSON.stringify({
      tokens: {
        accessToken: "tok_nested_camel",
        refreshToken: "ref_nested_camel",
        expiresIn: 3600,
      },
    });
    const result = parse(raw);
    assert.ok(result);
    assert.equal(result.access_token, "tok_nested_camel");
    assert.equal(result.refresh_token, "ref_nested_camel");
  });

  it("should fallback expires_at when no expiry field present", () => {
    const before = Date.now();
    const raw = JSON.stringify({
      access_token: "tok_no_exp",
      refresh_token: "ref_no_exp",
    });
    const result = parse(raw);
    const after = Date.now();
    assert.ok(result);
    // Should default to ~1 hour from now
    assert.ok(result.expires_at >= before + 3_600_000 - 1000);
    assert.ok(result.expires_at <= after + 3_600_000 + 1000);
  });
});
