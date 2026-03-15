/**
 * Unit tests for dynamic model discovery
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  _resetForTesting,
  getModels,
  getTierMapping,
  getDefaultModel,
  mapModelByTier,
} from "../src/models.js";

describe("models", () => {
  it("should have fallback models on init", () => {
    _resetForTesting();
    const models = getModels();
    assert.ok(Object.keys(models).length > 0, "should have some models");
    assert.ok(models["gpt-5.3-codex"], "should have gpt-5.3-codex");
  });

  it("should have correct tier mapping", () => {
    _resetForTesting();
    const mapping = getTierMapping();
    assert.equal(mapping.opus, "gpt-5.1-codex-max");
    assert.equal(mapping.sonnet, "gpt-5.3-codex");
    assert.equal(mapping.haiku, "gpt-5.1-codex-mini");
  });

  it("should return default model", () => {
    _resetForTesting();
    const model = getDefaultModel();
    assert.equal(model, "gpt-5.3-codex");
  });

  it("should map opus to high-tier model", () => {
    _resetForTesting();
    assert.equal(mapModelByTier("claude-opus-4"), "gpt-5.1-codex-max");
  });

  it("should map sonnet to mid-tier model", () => {
    _resetForTesting();
    assert.equal(mapModelByTier("claude-3-5-sonnet"), "gpt-5.3-codex");
  });

  it("should map haiku to fast-tier model", () => {
    _resetForTesting();
    assert.equal(mapModelByTier("claude-3-haiku"), "gpt-5.1-codex-mini");
  });

  it("should return null for unknown model", () => {
    _resetForTesting();
    assert.equal(mapModelByTier("gpt-4"), null);
  });

  it("should classify model tiers correctly", () => {
    _resetForTesting();
    const models = getModels();
    assert.equal(models["gpt-5.1-codex-max"].tier, "high");
    assert.equal(models["gpt-5.1-codex-mini"].tier, "fast");
    assert.equal(models["gpt-5.3-codex"].tier, "mid");
  });
});
