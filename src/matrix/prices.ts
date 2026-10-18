/**
 * Fetch model pricing from OpenRouter public API (no key required).
 */

import type { ModelPricing, PriceData } from "./types.js";

export type { ModelPricing, PriceData };

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

interface OpenRouterModel {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

export async function fetchModelPrices(
  requestedModels: string[],
): Promise<PriceData> {
  const response = await fetch(OPENROUTER_MODELS_URL);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenRouter models: HTTP ${response.status}`,
    );
  }

  const json = (await response.json()) as OpenRouterModelsResponse;
  const fetchedAt = new Date().toISOString();

  const models = new Map<string, ModelPricing>();

  for (const model of json.data) {
    if (!requestedModels.includes(model.id)) {
      continue;
    }

    const promptPrice = model.pricing?.prompt
      ? parseFloat(model.pricing.prompt)
      : NaN;
    const completionPrice = model.pricing?.completion
      ? parseFloat(model.pricing.completion)
      : NaN;

    if (!isNaN(promptPrice) && !isNaN(completionPrice)) {
      models.set(model.id, {
        modelId: model.id,
        promptPrice,
        completionPrice,
      });
    }
  }

  return { fetchedAt, models };
}

export function sortModelsByCost(
  models: string[],
  priceData: PriceData,
): string[] {
  return [...models].sort((a, b) => {
    const priceA = priceData.models.get(a);
    const priceB = priceData.models.get(b);

    if (!priceA && !priceB) return 0;
    if (!priceA) return 1;
    if (!priceB) return -1;

    const costA = priceA.promptPrice + priceA.completionPrice;
    const costB = priceB.promptPrice + priceB.completionPrice;

    return costA - costB;
  });
}

export function validatePricesForModels(
  priceData: PriceData,
  requestedModels: string[],
): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const modelId of requestedModels) {
    if (!priceData.models.has(modelId)) {
      missing.push(modelId);
    }
  }

  return { valid: missing.length === 0, missing };
}

export function calculateCallCost(
  promptTokens: number,
  completionTokens: number,
  pricing: ModelPricing,
): number {
  return promptTokens * pricing.promptPrice + completionTokens * pricing.completionPrice;
}

export function calculateWorstCaseCost(
  calls: number,
  iMax: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  return calls * (iMax * pricing.promptPrice + outputTokens * pricing.completionPrice);
}

export interface FixturePriceData extends PriceData {
  fixture: true;
}

export function createFixturePrices(models: string[]): FixturePriceData {
  const priceMap = new Map<string, ModelPricing>();

  for (const modelId of models) {
    priceMap.set(modelId, {
      modelId,
      promptPrice: 0,
      completionPrice: 0,
    });
  }

  return {
    fetchedAt: new Date().toISOString(),
    models: priceMap,
    fixture: true,
  };
}

export interface CreditCheckResult {
  limitRemaining: number | null;
  availableCredits: number | null;
  keyError: boolean;
  creditsError: boolean;
}

interface KeyResponse {
  data?: {
    limit_remaining?: number | null;
  };
}

interface CreditsResponse {
  data?: {
    total_credits?: number;
    total_usage?: number;
  };
}

export async function fetchCreditInfo(apiKey: string): Promise<CreditCheckResult> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  let limitRemaining: number | null = null;
  let availableCredits: number | null = null;
  let keyError = false;
  let creditsError = false;

  try {
    const keyRes = await fetch("https://openrouter.ai/api/v1/key", { headers });
    if (keyRes.ok) {
      const json = (await keyRes.json()) as KeyResponse;
      limitRemaining = json.data?.limit_remaining ?? null;
    } else {
      keyError = true;
    }
  } catch {
    keyError = true;
  }

  try {
    const creditsRes = await fetch("https://openrouter.ai/api/v1/credits", { headers });
    if (creditsRes.ok) {
      const json = (await creditsRes.json()) as CreditsResponse;
      const total = json.data?.total_credits ?? 0;
      const used = json.data?.total_usage ?? 0;
      availableCredits = total - used;
    } else {
      creditsError = true;
    }
  } catch {
    creditsError = true;
  }

  return { limitRemaining, availableCredits, keyError, creditsError };
}

export function calculateModelFullWorstCase(
  runs: number,
  taskCount: number,
  maxSteps: number,
  iMax: number,
  pricing: ModelPricing,
): number {
  const callsPerRun = taskCount * maxSteps;
  const outputTokens = 512;
  return runs * calculateWorstCaseCost(callsPerRun, iMax, outputTokens, pricing);
}

export function sortModelsByFullWorstCase(
  models: string[],
  priceData: PriceData,
  runs: number,
  taskCount: number,
  maxSteps: number,
  iMax: number,
): string[] {
  return [...models].sort((a, b) => {
    const priceA = priceData.models.get(a);
    const priceB = priceData.models.get(b);

    if (!priceA && !priceB) return 0;
    if (!priceA) return 1;
    if (!priceB) return -1;

    const costA = calculateModelFullWorstCase(runs, taskCount, maxSteps, iMax, priceA);
    const costB = calculateModelFullWorstCase(runs, taskCount, maxSteps, iMax, priceB);

    return costA - costB;
  });
}
