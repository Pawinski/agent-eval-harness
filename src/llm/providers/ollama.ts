/**
 * Ollama provider - local model inference via Ollama.
 */

import { PROJECT_NAME } from "../../name.js";
import {
  ProviderError,
  type ChatMessage,
  type LlmCompletionRequest,
  type LlmCompletionResponse,
  type LlmCallMeta,
} from "../client.js";
import { registerProvider, type LlmProvider, type ProviderInfo, type ProviderOptions } from "../provider.js";

const OLLAMA_INFO: ProviderInfo = {
  type: "ollama",
  name: "Ollama",
  requiresApiKey: false,
  baseUrl: "http://localhost:11434",
};

function stubReply(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const hint = lastUser?.content ?? "";
  if (/final answer/i.test(hint) || /answer:/i.test(hint)) {
    return "Thought: dry-run stub\nAction: finish\nAction Input: stub\nObservation: n/a\nFinal Answer: stub";
  }
  return "Thought: dry-run\nFinal Answer: stub";
}

export class OllamaProvider implements LlmProvider {
  readonly info = OLLAMA_INFO;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;
  private readonly dryRun: boolean;

  constructor(options: ProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OLLAMA_HOST ?? OLLAMA_INFO.baseUrl).replace(/\/$/, "");
    this.defaultModel = options.model ?? process.env.OLLAMA_MODEL ?? "llama3.2";
    this.defaultMaxTokens = options.maxTokens ?? 512;
    this.dryRun = options.dryRun ?? false;
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

    return this.doRequest(req, model);
  }

  private async doRequest(
    req: LlmCompletionRequest,
    model: string,
  ): Promise<LlmCompletionResponse> {
    const body = {
      model,
      messages: req.messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: m.role === "tool" ? `Tool result: ${m.content}` : m.content,
      })),
      stream: false,
      options: {
        temperature: req.temperature ?? 0,
        num_predict: req.maxTokens ?? this.defaultMaxTokens,
      },
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": PROJECT_NAME,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError(
        `Ollama connection failed: ${msg}. Is Ollama running at ${this.baseUrl}?`,
        { code: "connection_failed" }
      );
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as {
      message?: { content?: string };
      model?: string;
      prompt_eval_count?: number;
      eval_count?: number;
      error?: string;
    };

    if (json.error) {
      throw new ProviderError(`provider_error: ${json.error}`, { code: "ollama_error" });
    }

    if (!json.message) {
      throw new ProviderError("provider_error: no_message", { code: "no_message" });
    }

    const content = json.message.content ?? "";

    const _meta: LlmCallMeta = { temperatureSent: true };

    return {
      content,
      model: json.model ?? model,
      usage: {
        promptTokens: json.prompt_eval_count ?? 0,
        completionTokens: json.eval_count ?? 0,
      },
      raw: json,
      _meta,
    };
  }
}

export function createOllamaProvider(options: ProviderOptions = {}): LlmProvider {
  return new OllamaProvider(options);
}

registerProvider("ollama", createOllamaProvider, ["ollama"]);
