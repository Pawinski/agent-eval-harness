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
