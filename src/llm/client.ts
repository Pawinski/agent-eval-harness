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
};

export interface LlmClient {
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

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
};

const DEFAULT_MAX_TOKENS = 512;

export class OpenRouterClient implements LlmClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly dryRun: boolean;
  private readonly defaultMaxTokens: number;
  private readonly cacheBreakpoint: boolean;

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

    return this.doRequest(req, model, this.cacheBreakpoint);
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

    const body = {
      model,
      messages: req.messages.map(formatMessage),
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
    };

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
      if (useCacheBreakpoint) {
        return this.doRequest(req, model, false);
      }
      throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as {
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

    const content = json.choices?.[0]?.message?.content ?? "";
    const cachedTokens = parseCachedTokens(json.usage);

    return {
      content,
      model: json.model ?? model,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        ...(cachedTokens !== undefined ? { cachedTokens } : {}),
      },
      raw: json,
    };
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
