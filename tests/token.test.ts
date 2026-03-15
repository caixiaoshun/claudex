/**
 * Unit tests for token persistence and external credential detection
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { EXTERNAL_CANDIDATE_PATHS, isExpired } from "../src/token.js";
import type { SessionData } from "../src/token.js";

describe("token", () => {
  describe("isExpired", () => {
    it("should return false for future expiry", () => {
      const session: SessionData = {
        access_token: "test",
        refresh_token: "test",
        expires_at: Date.now() + 3_600_000,
      };
      assert.equal(isExpired(session), false);
    });

    it("should return true for past expiry", () => {
      const session: SessionData = {
        access_token: "test",
        refresh_token: "test",
        expires_at: Date.now() - 120_000,
      };
      assert.equal(isExpired(session), true);
    });

    it("should return true for expiry within 60s margin", () => {
      const session: SessionData = {
        access_token: "test",
        refresh_token: "test",
        expires_at: Date.now() + 30_000, // 30 seconds from now
      };
      assert.equal(isExpired(session), true);
    });
  });

  describe("Codex CLI auth.json parser", () => {
    const parser = EXTERNAL_CANDIDATE_PATHS[0].parse;

    it("should parse flat format", () => {
      const raw = JSON.stringify({
        accessToken: "acc_123",
        refreshToken: "ref_456",
        expiresAt: Date.now() + 3600000,
        accountId: "acct_789",
      });
      const result = parser(raw);
      assert.ok(result !== null);
      assert.equal(result!.access_token, "acc_123");
      assert.equal(result!.refresh_token, "ref_456");
      assert.equal(result!.account_id, "acct_789");
    });

    it("should parse nested tokens format", () => {
      const raw = JSON.stringify({
        tokens: {
          accessToken: "acc_123",
          refreshToken: "ref_456",
          expiresAt: Date.now() + 3600000,
        },
      });
      const result = parser(raw);
      assert.ok(result !== null);
      assert.equal(result!.access_token, "acc_123");
      assert.equal(result!.refresh_token, "ref_456");
    });

    it("should handle expires_at in seconds", () => {
      const nowSec = Math.floor(Date.now() / 1000) + 3600;
      const raw = JSON.stringify({
        accessToken: "acc_123",
        refreshToken: "ref_456",
        expiresAt: nowSec,
      });
      const result = parser(raw);
      assert.ok(result !== null);
      // Should be converted to ms
      assert.ok(result!.expires_at > Date.now());
    });

    it("should handle ISO string expiry", () => {
      const raw = JSON.stringify({
        accessToken: "acc_123",
        refreshToken: "ref_456",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      const result = parser(raw);
      assert.ok(result !== null);
      assert.ok(result!.expires_at > Date.now());
    });

    it("should return null for missing tokens", () => {
      const raw = JSON.stringify({ foo: "bar" });
      const result = parser(raw);
      assert.equal(result, null);
    });
  });

  describe("opencode session.json parser", () => {
    const parser = EXTERNAL_CANDIDATE_PATHS[1].parse;

    it("should parse flat format", () => {
      const raw = JSON.stringify({
        access_token: "acc_123",
        refresh_token: "ref_456",
        expires_at: Date.now() + 3600000,
      });
      const result = parser(raw);
      assert.ok(result !== null);
      assert.equal(result!.access_token, "acc_123");
      assert.equal(result!.refresh_token, "ref_456");
    });

    it("should parse codex-nested format", () => {
      const raw = JSON.stringify({
        codex: {
          access_token: "acc_123",
          refresh_token: "ref_456",
          expires_at: Date.now() + 3600000,
          account_id: "acct_789",
        },
      });
      const result = parser(raw);
      assert.ok(result !== null);
      assert.equal(result!.access_token, "acc_123");
      assert.equal(result!.account_id, "acct_789");
    });
  });

  describe("opencode v2 auth/codex.json parser", () => {
    const parser = EXTERNAL_CANDIDATE_PATHS[2].parse;

    it("should parse flat format", () => {
      const raw = JSON.stringify({
        access_token: "acc_123",
        refresh_token: "ref_456",
        expires_at: Date.now() + 3600000,
      });
      const result = parser(raw);
      assert.ok(result !== null);
      assert.equal(result!.access_token, "acc_123");
      assert.equal(result!.refresh_token, "ref_456");
    });

    it("should return null for missing tokens", () => {
      const raw = JSON.stringify({ data: "nothing" });
      const result = parser(raw);
      assert.equal(result, null);
    });
  });
});
