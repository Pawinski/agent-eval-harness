/**
 * OpenRouter-style multi-model LLM client.
 * Pluggable model id via env MODEL; auth via OPENROUTER_API_KEY.
 * Stub-friendly: dry-run mode when no key is set.
 */

import { getCacheBreakpointEnabled } from "../cache-breakpoint.js";
import { PROJECT_NAME } from "../name.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
};

export type LlmCompletionRequest = {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type LlmCompletionResponse = {
  content: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number; cachedTokens?: number };
  raw?: unknown;
  _meta?: LlmCallMeta;
};

export interface LlmCallMeta {
  retries?: number;
  droppedParameters?: string[];
  providerError?: { code?: string; type?: string };
}

export interface LlmClient {
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

/** Default retry backoff delays in milliseconds for 429 responses */
export const DEFAULT_RETRY_DELAYS = [15_000, 60_000, 180_000];

export type RetryConfig = {
  /** Array of delay times in ms for each retry attempt (default: [15000, 60000, 180000]) */
  delays?: number[];
  /** Function to call before each retry to check budget/cap. Throw to abort retry. */
  preRetryCheck?: () => Promise<void> | void;
  /** Custom sleep function for testing (defaults to real setTimeout-based sleep) */
  sleep?: (ms: number) => Promise<void>;
};

export type OpenRouterClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  /** When true (or no API key), returns a deterministic stub reply instead of calling the network. */
  dryRun?: boolean;
  /** Default max_tokens (defaults to 512, overridden by MAX_TOKENS env). */
  maxTokens?: number;
  /** Enable cache breakpoint (cache_control ephemeral on system message). */
  cacheBreakpoint?: boolean;
  /** Retry configuration for 429 rate limit responses */
  retryConfig?: RetryConfig;
  /** Supported parameters cache - set by matrix runner after fetching /models */
  supportedParameters?: Map<string, Set<string>>;
  /** Callback when parameters are dropped from request */
  onDroppedParameters?: (model: string, dropped: string[]) => void;
};

const DEFAULT_MAX_TOKENS = 512;

/** Error class for provider errors (200 with error object, empty choices, missing usage) */
export class ProviderError extends Error {
  readonly code?: string;
  readonly type?: string;
  readonly isRateLimited: boolean = false;

  constructor(message: string, opts?: { code?: string; type?: string }) {
    super(message);
    this.name = "ProviderError";
    this.code = opts?.code;
    this.type = opts?.type;
  }
}

/** Error class for rate limit exhaustion (all retries failed) */
export class RateLimitExhaustedError extends Error {
  readonly retries: number;
  readonly model: string;

  constructor(model: string, retries: number) {
    super(`Rate limit exhausted for ${model} after ${retries} retries`);
    this.name = "RateLimitExhaustedError";
    this.retries = retries;
    this.model = model;
  }
}

/** Parse RETRY_DELAYS_MS (comma-separated ms, e.g. "15000,60000,180000"); undefined if unset/invalid. */
export function parseRetryDelaysEnv(raw: string | undefined): number[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((p) => Number(p.trim()));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
  return parts;
}

/** Default sleep using setTimeout */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenRouterClient implements LlmClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly dryRun: boolean;
  private readonly defaultMaxTokens: number;
  private readonly cacheBreakpoint: boolean;
  private readonly retryDelays: number[];
  private readonly preRetryCheck?: () => Promise<void> | void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly supportedParameters?: Map<string, Set<string>>;
  private readonly onDroppedParameters?: (model: string, dropped: string[]) => void;

  constructor(opts: OpenRouterClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.baseUrl = (opts.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE).replace(
      /\/$/,
      "",
    );
    this.defaultModel = opts.defaultModel ?? process.env.MODEL ?? "openai/gpt-4o-mini";
    this.dryRun = opts.dryRun ?? !this.apiKey;

    const envMaxTokens = process.env.MAX_TOKENS;
    this.defaultMaxTokens =
      opts.maxTokens ?? (envMaxTokens ? parseInt(envMaxTokens, 10) : DEFAULT_MAX_TOKENS);

    this.cacheBreakpoint =
      opts.cacheBreakpoint ?? getCacheBreakpointEnabled().enabled;

    this.retryDelays =
      opts.retryConfig?.delays ?? parseRetryDelaysEnv(process.env.RETRY_DELAYS_MS) ?? DEFAULT_RETRY_DELAYS;
    this.preRetryCheck = opts.retryConfig?.preRetryCheck;
    this.sleep = opts.retryConfig?.sleep ?? defaultSleep;
    this.supportedParameters = opts.supportedParameters;
    this.onDroppedParameters = opts.onDroppedParameters;
  }

  get modelId(): string {
    return this.defaultModel;
  }

  get isDryRun(): boolean {
    return this.dryRun;
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const model = req.model ?? this.defaultModel;

    if (this.dryRun) {
      return {
        content: stubReply(req.messages),
        model: `${model}#dry-run`,
        usage: { promptTokens: 0, completionTokens: 0 },
      };
    }

    if (!this.apiKey) {
      throw new Error("OPENROUTER_API_KEY is required for live LLM calls");
    }

    return this.doRequestWithRetry(req, model, this.cacheBreakpoint);
  }

  private async doRequestWithRetry(
    req: LlmCompletionRequest,
    model: string,
    useCacheBreakpoint: boolean,
  ): Promise<LlmCompletionResponse> {
    let retries = 0;

    while (true) {
      try {
        const result = await this.doRequest(req, model, useCacheBreakpoint);
        if (retries > 0) {
          result._meta = { ...result._meta, retries };
        }
        return result;
      } catch (err) {
        if (err instanceof Error && err.message.includes("HTTP 429")) {
          if (retries >= this.retryDelays.length) {
            throw new RateLimitExhaustedError(model, retries);
          }

          if (this.preRetryCheck) {
            await this.preRetryCheck();
          }

          const delay = this.retryDelays[retries];
          await this.sleep(delay);
          retries++;
          continue;
        }
        throw err;
      }
    }
  }

  private async doRequest(
    req: LlmCompletionRequest,
    model: string,
    useCacheBreakpoint: boolean,
  ): Promise<LlmCompletionResponse> {
    const formatMessage = (m: ChatMessage, idx: number) => {
      const base = {
        role: m.role,
        ...(m.name ? { name: m.name } : {}),
      };

      if (useCacheBreakpoint && idx === 0 && m.role === "system") {
        return {
          ...base,
          content: [
            {
              type: "text",
              text: m.content,
              cache_control: { type: "ephemeral" },
            },
          ],
        };
      }

      return { ...base, content: m.content };
    };

    const rawBody: Record<string, unknown> = {
      model,
      messages: req.messages.map(formatMessage),
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
    };

    const { body, droppedParameters } = this.filterParameters(rawBody, model);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/Pawinski/basilisk-eval",
        "X-Title": PROJECT_NAME,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      if (useCacheBreakpoint && res.status !== 429) {
        return this.doRequest(req, model, false);
      }
      throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as {
      error?: { code?: string; type?: string; message?: string };
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: {
          cached_tokens?: number;
          cache_read?: number;
        };
        cache_read_input_tokens?: number;
      };
    };

    if (json.error) {
      throw new ProviderError(
        `provider_error: ${json.error.code ?? json.error.type ?? "unknown"}`,
        { code: json.error.code, type: json.error.type }
      );
    }

    if (!json.choices || json.choices.length === 0) {
      throw new ProviderError("provider_error: empty_choices", { code: "empty_choices" });
    }

    if (!json.usage) {
      throw new ProviderError("provider_error: missing_usage", { code: "missing_usage" });
    }

    const content = json.choices[0]?.message?.content ?? "";
    const cachedTokens = parseCachedTokens(json.usage);

    const _meta: LlmCallMeta = {};
    if (droppedParameters.length > 0) {
      _meta.droppedParameters = droppedParameters;
      this.onDroppedParameters?.(model, droppedParameters);
    }

    return {
      content,
      model: json.model ?? model,
      usage: {
        promptTokens: json.usage.prompt_tokens,
        completionTokens: json.usage.completion_tokens,
        ...(cachedTokens !== undefined ? { cachedTokens } : {}),
      },
      raw: json,
      ...(Object.keys(_meta).length > 0 ? { _meta } : {}),
    };
  }

  private filterParameters(
    body: Record<string, unknown>,
    model: string,
  ): { body: Record<string, unknown>; droppedParameters: string[] } {
    if (!this.supportedParameters) {
      return { body, droppedParameters: [] };
    }

    const supported = this.supportedParameters.get(model);
    if (!supported) {
      return { body, droppedParameters: [] };
    }

    const droppedParameters: string[] = [];
    const filtered: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(body)) {
      if (key === "model" || key === "messages") {
        filtered[key] = value;
      } else if (supported.has(key)) {
        filtered[key] = value;
      } else {
        droppedParameters.push(key);
      }
    }

    return { body: filtered, droppedParameters };
  }
}

export function parseCachedTokens(
  usage:
    | {
        prompt_tokens_details?: {
          cached_tokens?: number;
          cache_read?: number;
        };
        cache_read_input_tokens?: number;
      }
    | undefined,
): number | undefined {
  if (!usage) return undefined;

  if (
    usage.prompt_tokens_details?.cached_tokens !== undefined &&
    typeof usage.prompt_tokens_details.cached_tokens === "number"
  ) {
    return usage.prompt_tokens_details.cached_tokens;
  }

  if (
    usage.cache_read_input_tokens !== undefined &&
    typeof usage.cache_read_input_tokens === "number"
  ) {
    return usage.cache_read_input_tokens;
  }

  if (
    usage.prompt_tokens_details?.cache_read !== undefined &&
    typeof usage.prompt_tokens_details.cache_read === "number"
  ) {
    return usage.prompt_tokens_details.cache_read;
  }

  return undefined;
}

/** Deterministic stub so the suite can smoke without a key. */
function stubReply(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const hint = lastUser?.content ?? "";
  // Minimal ReAct-shaped stub: prefer Final Answer when the prompt asks for one.
  if (/final answer/i.test(hint) || /answer:/i.test(hint)) {
    return "Thought: dry-run stub\nAction: finish\nAction Input: stub\nObservation: n/a\nFinal Answer: stub";
  }
  return "Thought: dry-run\nFinal Answer: stub";
}

export function createLlmClient(opts?: OpenRouterClientOptions): LlmClient {
  return new OpenRouterClient(opts);
}
