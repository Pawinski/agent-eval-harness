/**
 * LLM Provider abstraction - supports multiple backends (OpenRouter, OpenAI, Anthropic, Ollama).
 */

import type { LlmClient, RetryConfig } from "./client.js";

export type ProviderType = "openrouter" | "openai" | "anthropic" | "ollama";

export interface ProviderInfo {
  type: ProviderType;
  name: string;
  /** Whether the provider requires an API key */
  requiresApiKey: boolean;
  /** Base URL for the provider's API */
  baseUrl: string;
}

export interface LlmProvider extends LlmClient {
  /** Provider metadata */
  readonly info: ProviderInfo;
  /** Current model ID */
  readonly modelId: string;
  /** Whether running in dry-run/stub mode */
  readonly isDryRun: boolean;
}

export interface ProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  dryRun?: boolean;
  retryConfig?: RetryConfig;
}

export type ProviderFactory = (options: ProviderOptions) => LlmProvider;

const providerFactories = new Map<ProviderType, ProviderFactory>();
const modelPrefixMap = new Map<string, ProviderType>();

export function registerProvider(
  type: ProviderType,
  factory: ProviderFactory,
  modelPrefixes: string[] = [],
): void {
  providerFactories.set(type, factory);
  for (const prefix of modelPrefixes) {
    modelPrefixMap.set(prefix.toLowerCase(), type);
  }
}

export function getProviderFactory(type: ProviderType): ProviderFactory | undefined {
  return providerFactories.get(type);
}

export function detectProviderFromModel(modelId: string): ProviderType | null {
  const lowerModel = modelId.toLowerCase();
  
  for (const [prefix, type] of modelPrefixMap) {
    if (lowerModel.startsWith(prefix + "/") || lowerModel.startsWith(prefix + ":")) {
      return type;
    }
  }
  
  if (lowerModel.startsWith("gpt-") || lowerModel.startsWith("o1-") || lowerModel.startsWith("o3-")) {
    return "openai";
  }
  if (lowerModel.startsWith("claude-")) {
    return "anthropic";
  }
  if (lowerModel.includes(":") && !lowerModel.includes("/")) {
    return "ollama";
  }
  
  return null;
}

export function detectProviderFromEnv(): ProviderType {
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OLLAMA_HOST) return "ollama";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  return "openrouter";
}

export interface CreateProviderOptions extends ProviderOptions {
  provider?: ProviderType;
}

export function createProvider(options: CreateProviderOptions = {}): LlmProvider {
  let providerType = options.provider;
  
  if (!providerType && options.model) {
    providerType = detectProviderFromModel(options.model) ?? undefined;
  }
  
  if (!providerType) {
    providerType = detectProviderFromEnv();
  }
  
  const factory = providerFactories.get(providerType);
  if (!factory) {
    throw new Error(`Unknown provider type: ${providerType}. Available: ${[...providerFactories.keys()].join(", ")}`);
  }
  
  return factory(options);
}

export function listProviders(): ProviderType[] {
  return [...providerFactories.keys()];
}

export function isProviderRegistered(type: ProviderType): boolean {
  return providerFactories.has(type);
}
