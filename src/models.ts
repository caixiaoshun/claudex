/**
 * Dynamic model discovery — fetch available Codex models and map Anthropic tiers.
 */

import * as logger from "./logger.js";

// ---------- Types ----------

export interface CodexModelInfo {
  slug: string;
  display_name: string;
  description?: string;
  priority: number;
  supported_in_api: boolean;
  visibility: string;
}

export interface ModelEntry {
  name: string;
  description: string;
  tier: "high" | "mid" | "fast";
}

export interface TierMapping {
  opus: string;
  sonnet: string;
  haiku: string;
}

// ---------- State ----------

let cachedModels: Record<string, ModelEntry> = {};
let cachedTierMapping: TierMapping = {
  opus: "gpt-5.1-codex-max",
  sonnet: "gpt-5.3-codex",
  haiku: "gpt-5.1-codex-mini",
};
let lastFetchTime = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const FALLBACK_MODELS: Record<string, ModelEntry> = {
  "gpt-5.4": {
    name: "GPT-5.4",
    description: "Latest GPT-5.4 model",
    tier: "high",
  },
  "gpt-5.3-codex": {
    name: "GPT-5.3 Codex",
    description: "Default balanced model for coding tasks",
    tier: "mid",
  },
  "gpt-5.2-codex": {
    name: "GPT-5.2 Codex",
    description: "Previous generation Codex model",
    tier: "mid",
  },
  "gpt-5.1-codex": {
    name: "GPT-5.1 Codex",
    description: "GPT-5.1 based Codex model",
    tier: "mid",
  },
  "gpt-5.1-codex-max": {
    name: "GPT-5.1 Codex Max",
    description: "Highest capability Codex model with maximum reasoning",
    tier: "high",
  },
  "gpt-5.1-codex-mini": {
    name: "GPT-5.1 Codex Mini",
    description: "Lightweight fast Codex model",
    tier: "fast",
  },
  "gpt-5.2": {
    name: "GPT-5.2",
    description: "General GPT-5.2 model",
    tier: "mid",
  },
};

const FALLBACK_TIER_MAPPING: TierMapping = {
  opus: "gpt-5.1-codex-max",
  sonnet: "gpt-5.3-codex",
  haiku: "gpt-5.1-codex-mini",
};

const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";

// ---------- Tier Classification ----------

function classifyTier(slug: string): "high" | "mid" | "fast" {
  if (/-(max|pro)\b/i.test(slug)) return "high";
  if (/-(mini|fast|lite)\b/i.test(slug)) return "fast";
  return "mid";
}

function deriveTierMapping(models: Record<string, ModelEntry>): TierMapping {
  const slugs = Object.keys(models);
  if (slugs.length === 0) return { ...FALLBACK_TIER_MAPPING };

  const highModels = slugs.filter((s) => models[s].tier === "high");
  const midModels = slugs.filter((s) => models[s].tier === "mid");
  const fastModels = slugs.filter((s) => models[s].tier === "fast");

  const opus =
    highModels.find((s) => /-(max|pro)\b/i.test(s)) ||
    highModels[0] ||
    slugs[0];
  const haiku =
    fastModels.find((s) => /-(mini|fast|lite)\b/i.test(s)) ||
    fastModels[0] ||
    slugs[slugs.length - 1];
  const sonnet =
    midModels[0] || slugs.find((s) => s !== opus && s !== haiku) || slugs[0];

  return { opus, sonnet, haiku };
}

// ---------- Fetching ----------

export async function fetchModelsFromAPI(
  accessToken: string,
  accountId?: string
): Promise<Record<string, ModelEntry> | null> {
  const baseEndpoint =
    process.env.CODEX_API_ENDPOINT ||
    "https://chatgpt.com/backend-api/codex/responses";
  const modelsUrl = baseEndpoint.replace(/\/responses\/?$/, "/models");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": `claudex/1.0.0 (${process.platform} ${process.arch})`,
    originator: "codex-cli",
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  try {
    const res = await fetch(modelsUrl, { method: "GET", headers });
    if (!res.ok) {
      logger.warn(`Models endpoint returned ${res.status}`, {
        url: modelsUrl,
      });
      return null;
    }

    const body = (await res.json()) as { models?: CodexModelInfo[] };
    if (!body.models || !Array.isArray(body.models)) {
      logger.warn("Models endpoint returned unexpected format");
      return null;
    }

    const result: Record<string, ModelEntry> = {};
    const sorted = [...body.models]
      .filter((m) => m.supported_in_api && m.visibility !== "none")
      .sort((a, b) => b.priority - a.priority);

    for (const m of sorted) {
      result[m.slug] = {
        name: m.display_name || m.slug,
        description: m.description || "",
        tier: classifyTier(m.slug),
      };
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    logger.warn(
      `Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

// ---------- Public API ----------

export async function initModels(
  accessToken?: string,
  accountId?: string
): Promise<void> {
  if (accessToken) {
    const fetched = await fetchModelsFromAPI(accessToken, accountId);
    if (fetched) {
      cachedModels = fetched;
      cachedTierMapping = deriveTierMapping(cachedModels);
      lastFetchTime = Date.now();
      logger.info(
        `Loaded ${Object.keys(cachedModels).length} models from Codex API`
      );
      return;
    }
  }

  logger.warn(
    "Using fallback model list — Codex models endpoint was unreachable"
  );
  cachedModels = { ...FALLBACK_MODELS };
  cachedTierMapping = { ...FALLBACK_TIER_MAPPING };
  lastFetchTime = Date.now();
}

export async function refreshModels(
  accessToken?: string,
  accountId?: string
): Promise<boolean> {
  if (!accessToken) {
    logger.warn("Cannot refresh models without access token");
    return false;
  }
  const fetched = await fetchModelsFromAPI(accessToken, accountId);
  if (fetched) {
    cachedModels = fetched;
    cachedTierMapping = deriveTierMapping(cachedModels);
    lastFetchTime = Date.now();
    logger.info(
      `Refreshed ${Object.keys(cachedModels).length} models from Codex API`
    );
    return true;
  }
  logger.warn("Model refresh failed — keeping existing model list");
  return false;
}

export function startPeriodicRefresh(
  intervalMs: number,
  getToken: () => Promise<{
    access_token: string;
    account_id?: string;
  } | null>
): void {
  stopPeriodicRefresh();
  refreshTimer = setInterval(async () => {
    const session = await getToken().catch(() => null);
    if (session) {
      await refreshModels(session.access_token, session.account_id);
    }
  }, intervalMs);
  refreshTimer.unref();
}

export function stopPeriodicRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function getModels(): Record<string, ModelEntry> {
  return cachedModels;
}

export function getTierMapping(): TierMapping {
  return cachedTierMapping;
}

export function getLastFetchTime(): number {
  return lastFetchTime;
}

export function getDefaultModel(): string {
  return cachedTierMapping.sonnet || DEFAULT_CODEX_MODEL;
}

export function mapModelByTier(anthropicModel: string): string | null {
  if (/opus/i.test(anthropicModel)) return cachedTierMapping.opus;
  if (/sonnet/i.test(anthropicModel)) return cachedTierMapping.sonnet;
  if (/haiku/i.test(anthropicModel)) return cachedTierMapping.haiku;
  return null;
}

// ---------- Testing ----------

export function _resetForTesting(): void {
  cachedModels = { ...FALLBACK_MODELS };
  cachedTierMapping = { ...FALLBACK_TIER_MAPPING };
  lastFetchTime = 0;
  stopPeriodicRefresh();
}

// Initialize with fallback defaults
cachedModels = { ...FALLBACK_MODELS };
cachedTierMapping = { ...FALLBACK_TIER_MAPPING };
