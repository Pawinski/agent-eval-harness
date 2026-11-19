/**
 * Configuration loader with layered precedence: defaults < file < env < CLI.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  EvalConfig,
  PartialEvalConfig,
  PartialLlmConfig,
} from "./types.js";
import { DEFAULT_CONFIG, ENV_VAR_MAP } from "./defaults.js";

const CONFIG_FILE_NAMES = ["eval.config.json", "eval.config.js", "eval.config.ts"];

export interface LoadConfigOptions {
  /** Working directory to search for config file (defaults to cwd) */
  cwd?: string;
  /** Explicit config file path (skips search) */
  configPath?: string;
  /** Environment variables (defaults to process.env) */
  env?: Record<string, string | undefined>;
  /** CLI overrides (highest precedence) */
  cliOverrides?: PartialEvalConfig;
}

function deepMergeConfig(base: EvalConfig, override: PartialEvalConfig): EvalConfig {
  const result: EvalConfig = structuredClone(base);
  
  if (override.llm) {
    result.llm = { ...result.llm, ...override.llm };
  }
  if (override.retry) {
    result.retry = { ...result.retry, ...override.retry };
  }
  if (override.agent) {
    result.agent = { ...result.agent, ...override.agent };
  }
  if (override.sandbox) {
    result.sandbox = { ...result.sandbox, ...override.sandbox };
  }
  if (override.matrix) {
    result.matrix = { ...result.matrix, ...override.matrix };
  }
  
  return result;
}

function findConfigFile(cwd: string): string | null {
  for (const name of CONFIG_FILE_NAMES) {
    const filePath = path.join(cwd, name);
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

function loadConfigFromFile(filePath: string): PartialEvalConfig {
  const ext = path.extname(filePath);
  
  if (ext === ".json") {
    const content = readFileSync(filePath, "utf8");
    return JSON.parse(content) as PartialEvalConfig;
  }
  
  throw new Error(
    `Unsupported config file format: ${ext}. Use eval.config.json for static config.`
  );
}

export function parseRetryDelays(raw: string): number[] | null {
  if (!raw) return null;
  const pieces = raw.split(",");
  if (pieces.length === 0 || pieces.some((p) => p.trim() === "")) return null;
  const parts: number[] = [];
  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) return null;
    parts.push(parseInt(trimmed, 10));
  }
  return parts;
}

function loadConfigFromEnv(env: Record<string, string | undefined>): PartialEvalConfig {
  const config: PartialEvalConfig = {};

  const apiKey = env[ENV_VAR_MAP["llm.apiKey"]];
  const baseUrl = env[ENV_VAR_MAP["llm.baseUrl"]];
  const defaultModel = env[ENV_VAR_MAP["llm.defaultModel"]];
  const maxTokensRaw = env[ENV_VAR_MAP["llm.maxCompletionTokens"]];
  const cacheBreakpointRaw = env[ENV_VAR_MAP["llm.cacheBreakpoint"]];
  const retryDelaysRaw = env[ENV_VAR_MAP["retry.delays"]];

  const llm: PartialLlmConfig = {};
  if (apiKey !== undefined) llm.apiKey = apiKey;
  if (baseUrl !== undefined) llm.baseUrl = baseUrl;
  if (defaultModel !== undefined) llm.defaultModel = defaultModel;
  if (maxTokensRaw !== undefined) {
    const parsed = parseInt(maxTokensRaw, 10);
    if (!isNaN(parsed) && parsed > 0) llm.maxCompletionTokens = parsed;
  }
  if (cacheBreakpointRaw !== undefined) {
    llm.cacheBreakpoint = cacheBreakpointRaw === "1" || cacheBreakpointRaw.toLowerCase() === "true";
  }
  if (Object.keys(llm).length > 0) config.llm = llm;

  if (retryDelaysRaw !== undefined) {
    const parsed = parseRetryDelays(retryDelaysRaw);
    if (parsed) {
      config.retry = { delays: parsed };
    }
  }

  return config;
}

export function loadConfig(options: LoadConfigOptions = {}): EvalConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  let config: EvalConfig = structuredClone(DEFAULT_CONFIG);

  const configPath = options.configPath ?? findConfigFile(cwd);
  if (configPath && existsSync(configPath)) {
    const fileConfig = loadConfigFromFile(configPath);
    config = deepMergeConfig(config, fileConfig);
  }

  const envConfig = loadConfigFromEnv(env);
  config = deepMergeConfig(config, envConfig);

  if (options.cliOverrides) {
    config = deepMergeConfig(config, options.cliOverrides);
  }

  return config;
}

export function getConfigValue<T>(config: EvalConfig, path: string): T {
  const parts = path.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || typeof current !== "object") {
      throw new Error(`Invalid config path: ${path}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current as T;
}

let cachedConfig: EvalConfig | null = null;

export function getConfig(options?: LoadConfigOptions): EvalConfig {
  if (options) {
    return loadConfig(options);
  }
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

export { DEFAULT_CONFIG } from "./defaults.js";
