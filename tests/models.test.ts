/**
 * Unit tests for dynamic model discovery module
 * 动态模型发现模块的单元测试
 */

import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import {
  _resetForTesting,
  getModels,
  getTierMapping,
  getDefaultModel,
  getLastFetchTime,
  mapModelByTier,
} from "../src/models.js";

describe("models module", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe("fallback models", () => {
    it("should have fallback models on init", () => {
      const models = getModels();
      assert.ok(Object.keys(models).length > 0, "should have models");
      assert.ok(models["gpt-5.3-codex"], "should have gpt-5.3-codex");
      assert.ok(models["gpt-5.1-codex-max"], "should have gpt-5.1-codex-max");
      assert.ok(
        models["gpt-5.1-codex-mini"],
        "should have gpt-5.1-codex-mini"
      );
      assert.ok(models["gpt-5.4"], "should have gpt-5.4");
    });

    it("should classify model tiers correctly in fallback", () => {
      const models = getModels();
      assert.equal(models["gpt-5.1-codex-max"].tier, "high");
      assert.equal(models["gpt-5.1-codex-mini"].tier, "fast");
      assert.equal(models["gpt-5.3-codex"].tier, "mid");
    });
  });

  describe("tier mapping", () => {
    it("should have fallback tier mapping", () => {
      const mapping = getTierMapping();
      assert.equal(mapping.opus, "gpt-5.1-codex-max");
      assert.equal(mapping.sonnet, "gpt-5.3-codex");
      assert.equal(mapping.haiku, "gpt-5.1-codex-mini");
    });
  });

  describe("getDefaultModel", () => {
    it("should return sonnet tier model as default", () => {
      const def = getDefaultModel();
      assert.equal(def, "gpt-5.3-codex");
    });
  });

  describe("mapModelByTier", () => {
    it("should map opus to highest-tier model", () => {
      assert.equal(mapModelByTier("claude-opus-4-20250514"), "gpt-5.1-codex-max");
    });

    it("should map sonnet to mid-tier model", () => {
      assert.equal(
        mapModelByTier("claude-3-5-sonnet-20241022"),
        "gpt-5.3-codex"
      );
    });

    it("should map haiku to fast-tier model", () => {
      assert.equal(
        mapModelByTier("claude-3-5-haiku-20241022"),
        "gpt-5.1-codex-mini"
      );
    });

    it("should return null for unrecognized models", () => {
      assert.equal(mapModelByTier("gpt-4"), null);
      assert.equal(mapModelByTier("something-else"), null);
    });
  });

  describe("getLastFetchTime", () => {
    it("should be 0 after reset", () => {
      assert.equal(getLastFetchTime(), 0);
    });
  });
});
