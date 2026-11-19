/**
 * Anthropic provider - direct Anthropic API access.
 */

import { PROJECT_NAME } from "../../name.js";
import {
  ProviderError,
  RateLimitExhaustedError,
  DEFAULT_RETRY_DELAYS,
  type ChatMessage,
  type LlmCompletionRequest,
  type LlmCompletionResponse,
  type LlmCallMeta,
} from "../client.js";
import { registerProvider, type LlmProvider, type ProviderInfo, type ProviderOptions } from "../provider.js";

const ANTHROPIC_INFO: ProviderInfo = {
  type: "anthropic",
  name: "Anthropic",
  requiresApiKey: true,
  baseUrl: "https://api.anthropic.com/v1",
};

const ANTHROPIC_API_VERSION = "2023-06-01";

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

function convertToAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  let system: string | undefined;
  const converted: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = msg.content;
    } else if (msg.role === "user" || msg.role === "assistant") {
      converted.push({ role: msg.role, content: msg.content });
    } else if (msg.role === "tool") {
      converted.push({ role: "user", content: `Tool result: ${msg.content}` });
    }
  }

  if (converted.length === 0 || converted[0].role !== "user") {
    converted.unshift({ role: "user", content: "Begin." });
  }

  return { system, messages: converted };
}

export class AnthropicProvider implements LlmProvider {
  readonly info = ANTHROPIC_INFO;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;
  private readonly dryRun: boolean;
  private readonly retryDelays: number[];
  private readonly preRetryCheck?: () => Promise<void> | void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? ANTHROPIC_INFO.baseUrl).replace(/\/$/, "");
    this.defaultModel = options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
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
      throw new Error("ANTHROPIC_API_KEY is required for Anthropic API calls");
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
        if (err instanceof Error && (err.message.includes("HTTP 429") || err.message.includes("rate_limit"))) {
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
    const { system, messages } = convertToAnthropicMessages(req.messages);

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
    };

    if (system) {
      body.system = system;
    }

    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey!,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "Content-Type": "application/json",
        "User-Agent": PROJECT_NAME,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as {
      error?: { type?: string; message?: string };
      content?: Array<{ type: string; text?: string }>;
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

    if (json.error) {
      throw new ProviderError(
        `provider_error: ${json.error.type ?? "unknown"}`,
        { type: json.error.type }
      );
    }

    if (!json.content || json.content.length === 0) {
      throw new ProviderError("provider_error: empty_content", { code: "empty_content" });
    }

    if (!json.usage) {
      throw new ProviderError("provider_error: missing_usage", { code: "missing_usage" });
    }

    const textContent = json.content.find((c) => c.type === "text");
    const content = textContent?.text ?? "";

    const _meta: LlmCallMeta = { temperatureSent: req.temperature !== undefined };

    return {
      content,
      model: json.model ?? model,
      usage: {
        promptTokens: json.usage.input_tokens,
        completionTokens: json.usage.output_tokens,
        ...(json.usage.cache_read_input_tokens !== undefined
          ? { cachedTokens: json.usage.cache_read_input_tokens }
          : {}),
      },
      raw: json,
      _meta,
    };
  }
}

export function createAnthropicProvider(options: ProviderOptions = {}): LlmProvider {
  return new AnthropicProvider(options);
}

registerProvider("anthropic", createAnthropicProvider, ["claude"]);
