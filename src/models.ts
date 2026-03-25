/**
 * Dynamic model discovery — fetch available Codex models and map Anthropic tiers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

export interface StartupMappingLine {
  matcher: string;
  target: string;
  example?: string;
}

// ---------- State ----------

let cachedModels: Record<string, ModelEntry> = {};
let cachedTierMapping: TierMapping = {
  opus: "gpt-5.4",
  sonnet: "gpt-5.4-mini",
  haiku: "gpt-5.4-nano",
};
let lastFetchTime = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const FALLBACK_MODELS: Record<string, ModelEntry> = {
  "gpt-5.4": {
    name: "GPT-5.4",
    description: "Frontier model for complex professional and coding work",
    tier: "high",
  },
  "gpt-5.4-mini": {
    name: "GPT-5.4 mini",
    description: "Strongest GPT-5.4 mini model for coding and subagents",
    tier: "mid",
  },
  "gpt-5.4-nano": {
    name: "GPT-5.4 nano",
    description: "Fast, cost-efficient GPT-5.4 model for simple tasks",
    tier: "fast",
  },
  "gpt-5.3-codex": {
    name: "GPT-5.3 Codex",
    description: "Most capable Codex-specialized coding model",
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
  opus: "gpt-5.4",
  sonnet: "gpt-5.4-mini",
  haiku: "gpt-5.4-nano",
};

const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";
const DEFAULT_CODEX_CLIENT_VERSION = "0.115.0";
const TIER_PREFERENCE_ORDER: Record<keyof TierMapping, string[]> = {
  opus: [
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
  ],
  sonnet: [
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.2",
    "gpt-5.1-codex",
    "gpt-5-mini",
  ],
  haiku: [
    "gpt-5.4-nano",
    "gpt-5-mini",
    "gpt-5.1-codex-mini",
    "gpt-5.4-mini",
  ],
};

// ---------- Tier Classification ----------

function classifyTier(slug: string): "high" | "mid" | "fast" {
  if (/^gpt-5\.4(?:$|-pro\b)/i.test(slug)) return "high";
  if (/^gpt-5\.4-mini\b/i.test(slug)) return "mid";
  if (/-(nano|fast|lite)\b/i.test(slug)) return "fast";
  if (/-(max|pro)\b/i.test(slug)) return "high";
  if (/-mini\b/i.test(slug)) return "fast";
  return "mid";
}

function pickPreferredModel(
  slugs: string[],
  preferred: string[],
  excluded = new Set<string>()
): string | null {
  for (const slug of preferred) {
    if (slugs.includes(slug) && !excluded.has(slug)) {
      return slug;
    }
  }
  return null;
}

function pickFirstByTier(
  models: Record<string, ModelEntry>,
  tier: ModelEntry["tier"],
  excluded = new Set<string>()
): string | null {
  for (const [slug, entry] of Object.entries(models)) {
    if (entry.tier === tier && !excluded.has(slug)) {
      return slug;
    }
  }
  return null;
}

function deriveTierMapping(models: Record<string, ModelEntry>): TierMapping {
  const slugs = Object.keys(models);
  if (slugs.length === 0) return { ...FALLBACK_TIER_MAPPING };

  const opus =
    pickPreferredModel(slugs, TIER_PREFERENCE_ORDER.opus) ||
    pickFirstByTier(models, "high") ||
    slugs[0];
  const used = new Set<string>([opus]);
  const sonnet =
    pickPreferredModel(slugs, TIER_PREFERENCE_ORDER.sonnet, used) ||
    pickFirstByTier(models, "mid", used) ||
    slugs.find((s) => !used.has(s)) ||
    opus;
  used.add(sonnet);
  const haiku =
    pickPreferredModel(slugs, TIER_PREFERENCE_ORDER.haiku, used) ||
    pickFirstByTier(models, "fast", used) ||
    slugs.find((s) => !used.has(s)) ||
    sonnet;

  return { opus, sonnet, haiku };
}

// ---------- Fetching ----------

function readClientVersionHint(): string | null {
  const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw) as { client_version?: unknown };
    return typeof parsed.client_version === "string"
      ? parsed.client_version
      : null;
  } catch {
    return null;
  }
}

export function getCodexClientVersion(): string {
  return (
    process.env.CODEX_CLIENT_VERSION ||
    readClientVersionHint() ||
    DEFAULT_CODEX_CLIENT_VERSION
  );
}

export function getModelsUrl(baseEndpoint?: string): string {
  const base =
    baseEndpoint ||
    process.env.CODEX_API_ENDPOINT ||
    "https://chatgpt.com/backend-api/codex/responses";
  const modelsUrl = base.replace(/\/responses\/?$/, "/models");
  const url = new URL(modelsUrl);
  if (!url.searchParams.has("client_version")) {
    url.searchParams.set("client_version", getCodexClientVersion());
  }
  return url.toString();
}

export async function fetchModelsFromAPI(
  accessToken: string,
  accountId?: string
): Promise<Record<string, ModelEntry> | null> {
  const modelsUrl = getModelsUrl();

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

export function getStartupMappingLines(): StartupMappingLine[] {
  return [
    {
      matcher: 'contains "opus"',
      target: cachedTierMapping.opus,
    },
    {
      matcher: 'contains "sonnet"',
      target: cachedTierMapping.sonnet,
      example: `sonnet4.6 -> ${cachedTierMapping.sonnet}`,
    },
    {
      matcher: 'contains "haiku"',
      target: cachedTierMapping.haiku,
    },
  ];
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

export function _setModelsForTesting(models: Record<string, ModelEntry>): void {
  cachedModels = { ...models };
  cachedTierMapping = deriveTierMapping(cachedModels);
  lastFetchTime = 0;
  stopPeriodicRefresh();
}

// Initialize with fallback defaults
cachedModels = { ...FALLBACK_MODELS };
cachedTierMapping = { ...FALLBACK_TIER_MAPPING };
