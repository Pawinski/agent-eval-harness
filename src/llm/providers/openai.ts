/**
 * OpenAI provider - direct OpenAI API access.
 */

import { PROJECT_NAME } from "../../name.js";
import {
  ProviderError,
  RateLimitExhaustedError,
  DEFAULT_RETRY_DELAYS,
  parseCachedTokens,
  type ChatMessage,
  type LlmCompletionRequest,
  type LlmCompletionResponse,
  type LlmCallMeta,
} from "../client.js";
import { registerProvider, type LlmProvider, type ProviderInfo, type ProviderOptions } from "../provider.js";

const OPENAI_INFO: ProviderInfo = {
  type: "openai",
  name: "OpenAI",
  requiresApiKey: true,
  baseUrl: "https://api.openai.com/v1",
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stubReply(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const hint = lastUser?.content ?? "";
  if (/final answer/i.test(hint) || /answer:/i.test(hint)) {
    return "Thought: dry-run stub\nAction: finish\nAction Input: stub\nObservation: n/a\nFinal Answer: stub";
  }
  return "Thought: dry-run\nFinal Answer: stub";
}

export class OpenAIProvider implements LlmProvider {
  readonly info = OPENAI_INFO;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;
  private readonly dryRun: boolean;
  private readonly retryDelays: number[];
  private readonly preRetryCheck?: () => Promise<void> | void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? OPENAI_INFO.baseUrl).replace(/\/$/, "");
    this.defaultModel = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    this.defaultMaxTokens = options.maxTokens ?? 512;
    this.dryRun = options.dryRun ?? !this.apiKey;
    this.retryDelays = options.retryConfig?.delays ?? DEFAULT_RETRY_DELAYS;
    this.preRetryCheck = options.retryConfig?.preRetryCheck;
    this.sleep = options.retryConfig?.sleep ?? defaultSleep;
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
      throw new Error("OPENAI_API_KEY is required for OpenAI API calls");
    }

    return this.doRequestWithRetry(req, model);
  }

  private async doRequestWithRetry(
    req: LlmCompletionRequest,
    model: string,
  ): Promise<LlmCompletionResponse> {
    let retries = 0;

    while (true) {
      try {
        const result = await this.doRequest(req, model);
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
  ): Promise<LlmCompletionResponse> {
    const body = {
      model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
      })),
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": PROJECT_NAME,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 500)}`);
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
        };
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

    const _meta: LlmCallMeta = { temperatureSent: true };

    return {
      content,
      model: json.model ?? model,
      usage: {
        promptTokens: json.usage.prompt_tokens,
        completionTokens: json.usage.completion_tokens,
        ...(cachedTokens !== undefined ? { cachedTokens } : {}),
      },
      raw: json,
      _meta,
    };
  }
}

export function createOpenAIProvider(options: ProviderOptions = {}): LlmProvider {
  return new OpenAIProvider(options);
}

registerProvider("openai", createOpenAIProvider, ["gpt", "o1", "o3"]);
