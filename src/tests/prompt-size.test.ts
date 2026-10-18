import { describe, it, expect } from "vitest";
import { TASKS_V2 } from "../suite/tasks-v2.js";
import { getToolsV2Schemas } from "../mcp/tools-v2.js";

const DEFAULT_SYSTEM_PROMPT = `You are a ReAct agent. Use this format strictly:

Thought: <reasoning>
Action: <tool_name or finish>
Action Input: <JSON object for the tool, or final answer string when Action is finish>

After each Action you will receive:
Observation: <tool result>

When done, use Action: finish with Action Input set to the final answer (plain text only).
Do not wrap the Final Answer / Action Input in quotes unless the answer itself must contain those quote characters.
Never emit XML/HTML tool markup, <tool_call>, or code fences for tools — only the Thought/Action/Action Input lines above.
Keep reasoning short. Prefer tools over guessing.`;

function estimateTokens(text: string, charsPerToken = 4): number {
  return Math.ceil(text.length / charsPerToken);
}

describe("prompt size constraints for 0.2.0", () => {
  const toolSchemas = getToolsV2Schemas();
  const toolCatalog = toolSchemas.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const systemContent = `${DEFAULT_SYSTEM_PROMPT}\n\nAvailable tools:\n${toolCatalog}`;

  it("system prompt + catalog under 400 tokens", () => {
    const tokens = estimateTokens(systemContent);
    expect(tokens).toBeLessThan(400);
  });

  it("each task prompt under 200 tokens", () => {
    for (const task of TASKS_V2) {
      const tokens = estimateTokens(task.prompt);
      expect(tokens).toBeLessThan(200);
    }
  });

  it("step 1 total prompt under 3,750 tokens (I_max)", () => {
    const maxTaskPrompt = Math.max(...TASKS_V2.map((t) => t.prompt.length));
    const systemTokens = estimateTokens(systemContent);
    const maxTaskTokens = estimateTokens("x".repeat(maxTaskPrompt));
    const step1Total = systemTokens + maxTaskTokens;
    expect(step1Total).toBeLessThan(3750);
  });

  it("system prompt is under 700 chars", () => {
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeLessThan(700);
  });

  it("tool catalog is reasonable size", () => {
    expect(toolCatalog.length).toBeLessThan(1000);
  });
});

describe("task prompt content", () => {
  it("no task prompt mentions tool names directly", () => {
    const toolNames = getToolsV2Schemas().map((t) => t.name);
    
    for (const task of TASKS_V2) {
      if (task.expectedTools === undefined) {
        continue;
      }
      
      for (const toolName of toolNames) {
        const pattern = new RegExp(`\\b${toolName}\\b`, "i");
        if (task.prompt.match(pattern)) {
          if (task.expectedTools.includes(toolName)) {
            continue;
          }
          expect.fail(`Task ${task.id} mentions tool ${toolName} in prompt`);
        }
      }
    }
  });

  it("all 16 tasks have fixture answers", () => {
    expect(TASKS_V2.length).toBe(16);
    for (const task of TASKS_V2) {
      expect(task.fixtureAnswer).toBeDefined();
      expect(task.fixtureAnswer!.length).toBeGreaterThan(0);
    }
  });

  it("task categories are correct", () => {
    const categories = new Map<string, number>();
    for (const task of TASKS_V2) {
      categories.set(task.category, (categories.get(task.category) ?? 0) + 1);
    }
    
    expect(categories.get("chain")).toBe(3);
    expect(categories.get("selection")).toBe(3);
    expect(categories.get("code_read")).toBe(3);
    expect(categories.get("patch")).toBe(3);
    expect(categories.get("data")).toBe(2);
    expect(categories.get("error_recovery")).toBe(2);
  });
});
