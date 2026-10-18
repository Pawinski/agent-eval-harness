/**
 * Payload identity proof: request bodies are byte-identical before/after rename.
 * Only the X-Title header value changes; body content is unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenRouterClient } from "../llm/client.js";
import { PROJECT_NAME } from "../name.js";

describe("payload-identity", () => {
  let originalFetch: typeof fetch;
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: string = "";

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedHeaders = Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)]),
      );
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "test response" } }],
          model: "test-model",
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("X-Title header uses PROJECT_NAME constant", async () => {
    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
    });

    await client.complete({
      messages: [{ role: "user", content: "test prompt" }],
    });

    expect(capturedHeaders["X-Title"]).toBe(PROJECT_NAME);
    expect(capturedHeaders["X-Title"]).toBe("agent-eval-harness");
  });

  it("HTTP-Referer header is unchanged", async () => {
    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
    });

    await client.complete({
      messages: [{ role: "user", content: "test prompt" }],
    });

    expect(capturedHeaders["HTTP-Referer"]).toBe(
      "https://github.com/Pawinski/basilisk-eval",
    );
  });

  it("request body structure is identical for same input", async () => {
    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
      maxTokens: 512,
    });

    const messages = [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "Hello" },
    ];

    await client.complete({ messages });

    const body = JSON.parse(capturedBody);

    expect(body).toEqual({
      model: "test/model",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
      temperature: 0,
      max_tokens: 512,
    });
  });

  it("task prompt bodies are deterministic", async () => {
    const client = new OpenRouterClient({
      apiKey: "test-key",
      defaultModel: "test/model",
    });

    const taskPrompt =
      'Use the echo tool with text "hello-basilisk". Then finish with exactly that echoed string as the final answer.';

    await client.complete({
      messages: [{ role: "user", content: taskPrompt }],
    });

    const body1 = capturedBody;

    await client.complete({
      messages: [{ role: "user", content: taskPrompt }],
    });

    const body2 = capturedBody;

    expect(body1).toBe(body2);
  });
});
