/**
 * Unit tests for dynamic model discovery
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  _resetForTesting,
  _setModelsForTesting,
  getModels,
  getTierMapping,
  getDefaultModel,
  getStartupMappingLines,
  getModelsUrl,
  mapModelByTier,
} from "../src/models.js";

describe("models", () => {
  it("should have fallback models on init", () => {
    _resetForTesting();
    const models = getModels();
    assert.ok(Object.keys(models).length > 0, "should have some models");
    assert.ok(models["gpt-5.4"], "should have gpt-5.4");
    assert.ok(models["gpt-5.4-mini"], "should have gpt-5.4-mini");
    assert.ok(models["gpt-5.4-nano"], "should have gpt-5.4-nano");
  });

  it("should have correct tier mapping", () => {
    _resetForTesting();
    const mapping = getTierMapping();
    assert.equal(mapping.opus, "gpt-5.4");
    assert.equal(mapping.sonnet, "gpt-5.4-mini");
    assert.equal(mapping.haiku, "gpt-5.4-nano");
  });

  it("should return default model", () => {
    _resetForTesting();
    const model = getDefaultModel();
    assert.equal(model, "gpt-5.4-mini");
  });

  it("should map opus to high-tier model", () => {
    _resetForTesting();
    assert.equal(mapModelByTier("claude-opus-4"), "gpt-5.4");
  });

  it("should map sonnet to mid-tier model", () => {
    _resetForTesting();
    assert.equal(mapModelByTier("claude-3-5-sonnet"), "gpt-5.4-mini");
  });

  it("should map haiku to fast-tier model", () => {
    _resetForTesting();
    assert.equal(mapModelByTier("claude-3-haiku"), "gpt-5.4-nano");
  });

  it("should return null for unknown model", () => {
    _resetForTesting();
    assert.equal(mapModelByTier("gpt-4"), null);
  });

  it("should classify model tiers correctly", () => {
    _resetForTesting();
    const models = getModels();
    assert.equal(models["gpt-5.4"].tier, "high");
    assert.equal(models["gpt-5.4-mini"].tier, "mid");
    assert.equal(models["gpt-5.4-nano"].tier, "fast");
  });

  it("should prefer the GPT-5.4 family when live models include it", () => {
    _setModelsForTesting({
      "gpt-5.4": {
        name: "GPT-5.4",
        description: "",
        tier: "high",
      },
      "gpt-5.4-mini": {
        name: "GPT-5.4 mini",
        description: "",
        tier: "mid",
      },
      "gpt-5.4-nano": {
        name: "GPT-5.4 nano",
        description: "",
        tier: "fast",
      },
      "gpt-5.3-codex": {
        name: "GPT-5.3 Codex",
        description: "",
        tier: "mid",
      },
    });

    assert.deepEqual(getTierMapping(), {
      opus: "gpt-5.4",
      sonnet: "gpt-5.4-mini",
      haiku: "gpt-5.4-nano",
    });
  });

  it("should expose startup mapping lines including sonnet example", () => {
    _resetForTesting();
    const lines = getStartupMappingLines();
    assert.deepEqual(lines, [
      {
        matcher: 'contains "opus"',
        target: "gpt-5.4",
      },
      {
        matcher: 'contains "sonnet"',
        target: "gpt-5.4-mini",
        example: "sonnet4.6 -> gpt-5.4-mini",
      },
      {
        matcher: 'contains "haiku"',
        target: "gpt-5.4-nano",
      },
    ]);
  });

  it("should append client_version when building the models URL", () => {
    const url = getModelsUrl("https://chatgpt.com/backend-api/codex/responses");
    assert.match(
      url,
      /^https:\/\/chatgpt\.com\/backend-api\/codex\/models\?client_version=/
    );
  });
});
