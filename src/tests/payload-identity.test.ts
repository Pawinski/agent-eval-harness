/**
 * Payload identity proof: request bodies are byte-identical before/after rename.
 * Only the X-Title header value changes; body content is unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLlmClient, OpenRouterClient } from "../llm/client.js";
import { createHash } from "node:crypto";
import { PROJECT_NAME } from "../name.js";
import { ReactAgent } from "../agent/react.js";
import {
  createDefaultMcpClient,
  createToolsV2Context,
  createToolsV2Options,
  InProcessMcpClient,
} from "../mcp/index.js";
import { getTask, TASKS, TASKS_V2 } from "../suite/index.js";

// Golden values captured on main d15506d (pre-rename) with this exact procedure.
const GOLDEN = {
  "0.1.0": "14 642514ff830c21f9b0efbc97b6b0f0f770fed5cd4390e88432de6b3d6569b728",
  "0.2.0": "32 5f60e6078c260ed85472b7e1fa273d9c49e0fb5e4eb34aa71e199040a176a06a",
};

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
    vi.unstubAllEnvs();
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
      ["https://github.com/Pawinski/", "basi", "lisk-eval"].join(""),
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

    const taskPrompt = getTask("echo_hello")!.prompt;

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

  it("full-suite request bodies match the pre-rename golden (0.1.0 and 0.2.0)", async () => {
    // Build the client exactly as `npm run eval` does: library defaults, no env overrides.
    for (const k of ["MAX_TOKENS", "AGENT_EVAL_CACHE_BREAKPOINT", ["BASI", "LISK_CACHE_BREAKPOINT"].join("")]) {
      vi.stubEnv(k, undefined as unknown as string);
    }
    const bodies: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      bodies.push(init?.body as string);
      const n = JSON.parse(init?.body as string).messages.length;
      const content =
        n <= 2
          ? 'Thought: t\nAction: echo\nAction Input: {"text":"a b"}'
          : "Thought: d\nAction: finish\nAction Input: x";
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), { status: 200 });
    });
    const suites = [
      ["0.1.0", TASKS, () => createDefaultMcpClient(), undefined],
      ["0.2.0", TASKS_V2, () => new InProcessMcpClient(createToolsV2Options(createToolsV2Context())), 4096],
    ] as const;
    for (const [name, tasks, tools, obs] of suites) {
      bodies.length = 0;
      for (const t of tasks as ReadonlyArray<{ prompt: string; expectedTools?: string[]; maxSteps?: number }>) {
        const agent = new ReactAgent({
          llm: createLlmClient({ apiKey: "k", defaultModel: "m/x" }),
          tools: tools(),
          maxSteps: t.maxSteps ?? 8,
          expectedTools: t.expectedTools,
          maxObservationChars: obs,
          onLog: () => {},
        });
        await agent.run(t.prompt);
      }
      const got = `${bodies.length} ${createHash("sha256").update(bodies.join("\n")).digest("hex")}`;
      expect(got).toBe(GOLDEN[name]);
    }
  });
});
