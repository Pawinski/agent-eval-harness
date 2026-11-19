/**
 * Configuration types for the eval harness.
 * All settings can come from: config file < env vars < CLI flags (later sources override).
 */

export type ProviderType = "openrouter" | "openai" | "anthropic" | "ollama";

export interface LlmConfig {
  /** LLM provider to use (auto-detected from model or env if not specified) */
  provider?: ProviderType;
  /** OpenRouter API key (env: OPENROUTER_API_KEY) */
  apiKey?: string;
  /** API base URL (provider-specific default if not set) */
  baseUrl: string;
  /** Default model ID in provider/model format */
  defaultModel: string;
  /** Max tokens per completion response */
  maxCompletionTokens: number;
  /** Enable cache breakpoint (cache_control ephemeral on system message) */
  cacheBreakpoint: boolean;
}

export interface RetryConfig {
  /** Delay times in ms for each retry attempt on 429 responses */
  delays: number[];
}

export interface AgentConfig {
  /** Default max steps for the ReAct loop */
  defaultMaxSteps: number;
  /** Max input tokens threshold for prompt size checks */
  maxInputTokens: number;
  /** Max characters for tool observation truncation */
  maxObservationChars: number;
}

export interface SandboxConfig {
  /** Timeout in ms for child process execution */
  childTimeoutMs: number;
  /** Timeout in ms for vm prelude script */
  preludeTimeoutMs: number;
  /** Timeout in ms for vm function script */
  functionTimeoutMs: number;
  /** Timeout in ms for vm call script */
  callTimeoutMs: number;
  /** Timeout in ms for permission model probe */
  permissionProbeTimeoutMs: number;
}

export interface MatrixConfig {
  /** Default suite version */
  defaultSuite: string;
  /** Default number of runs per model */
  defaultRuns: number;
  /** Default cost cap in USD */
  defaultCapUsd: number;
  /** Default models to evaluate (sorted by worst-case cost) */
  defaultModels: string[];
}

export interface EvalConfig {
  llm: LlmConfig;
  retry: RetryConfig;
  agent: AgentConfig;
  sandbox: SandboxConfig;
  matrix: MatrixConfig;
}

export interface PartialLlmConfig {
  provider?: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  maxCompletionTokens?: number;
  cacheBreakpoint?: boolean;
}

export interface PartialRetryConfig {
  delays?: number[];
}

export interface PartialAgentConfig {
  defaultMaxSteps?: number;
  maxInputTokens?: number;
  maxObservationChars?: number;
}

export interface PartialSandboxConfig {
  childTimeoutMs?: number;
  preludeTimeoutMs?: number;
  functionTimeoutMs?: number;
  callTimeoutMs?: number;
  permissionProbeTimeoutMs?: number;
}

export interface PartialMatrixConfig {
  defaultSuite?: string;
  defaultRuns?: number;
  defaultCapUsd?: number;
  defaultModels?: string[];
}

export interface PartialEvalConfig {
  llm?: PartialLlmConfig;
  retry?: PartialRetryConfig;
  agent?: PartialAgentConfig;
  sandbox?: PartialSandboxConfig;
  matrix?: PartialMatrixConfig;
}

export type ConfigSource = "default" | "file" | "env" | "cli";

export interface ConfigResolution<T> {
  value: T;
  source: ConfigSource;
}
