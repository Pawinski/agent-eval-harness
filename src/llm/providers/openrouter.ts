/**
 * OpenRouter provider - routes to multiple models via OpenRouter API.
 */

import { OpenRouterClient, type OpenRouterClientOptions } from "../client.js";
import {
  registerProvider,
  type LlmProvider,
  type ProviderInfo,
  type ProviderOptions,
} from "../provider.js";

const OPENROUTER_INFO: ProviderInfo = {
  type: "openrouter",
  name: "OpenRouter",
  requiresApiKey: true,
  baseUrl: "https://openrouter.ai/api/v1",
};

export class OpenRouterProvider implements LlmProvider {
  private readonly client: OpenRouterClient;
  readonly info = OPENROUTER_INFO;

  constructor(options: ProviderOptions = {}) {
    const clientOpts: OpenRouterClientOptions = {
      apiKey: options.apiKey ?? process.env.OPENROUTER_API_KEY,
      baseUrl: options.baseUrl ?? process.env.OPENROUTER_BASE_URL,
      defaultModel: options.model ?? process.env.MODEL ?? "openai/gpt-4o-mini",
      maxTokens: options.maxTokens,
      dryRun: options.dryRun,
      retryConfig: options.retryConfig,
    };
    this.client = new OpenRouterClient(clientOpts);
  }

  get modelId(): string {
    return this.client.modelId;
  }

  get isDryRun(): boolean {
    return this.client.isDryRun;
  }

  async complete(...args: Parameters<OpenRouterClient["complete"]>) {
    return this.client.complete(...args);
  }
}

export function createOpenRouterProvider(options: ProviderOptions = {}): LlmProvider {
  return new OpenRouterProvider(options);
}

registerProvider("openrouter", createOpenRouterProvider, [
  "openai",
  "anthropic",
  "google",
  "meta-llama",
  "mistralai",
  "cohere",
  "perplexity",
  "deepseek",
  "qwen",
  "nex-agi",
]);
