/**
 * Tests for the provider abstraction system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createProvider,
  detectProviderFromModel,
  detectProviderFromEnv,
  listProviders,
  isProviderRegistered,
  OpenRouterProvider,
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
  type LlmProvider,
} from "../llm/index.js";

describe("provider system", () => {
  describe("detectProviderFromModel", () => {
    it("detects openrouter from openai/ prefix", () => {
      expect(detectProviderFromModel("openai/gpt-4o")).toBe("openrouter");
    });

    it("detects openrouter from anthropic/ prefix", () => {
      expect(detectProviderFromModel("anthropic/claude-3-opus")).toBe("openrouter");
    });

    it("detects openrouter from meta-llama/ prefix", () => {
      expect(detectProviderFromModel("meta-llama/llama-3-70b")).toBe("openrouter");
    });

    it("detects openai from gpt- prefix", () => {
      expect(detectProviderFromModel("gpt-4o")).toBe("openai");
    });

    it("detects openai from o1- prefix", () => {
      expect(detectProviderFromModel("o1-preview")).toBe("openai");
    });

    it("detects anthropic from claude- prefix", () => {
      expect(detectProviderFromModel("claude-3-opus-20240229")).toBe("anthropic");
    });

    it("detects ollama from model:tag format", () => {
      expect(detectProviderFromModel("llama3:latest")).toBe("ollama");
    });

    it("returns null for unknown model format", () => {
      expect(detectProviderFromModel("some-random-model")).toBeNull();
    });

    it("is case insensitive", () => {
      expect(detectProviderFromModel("OPENAI/GPT-4O")).toBe("openrouter");
      expect(detectProviderFromModel("GPT-4o")).toBe("openai");
      expect(detectProviderFromModel("Claude-3-opus")).toBe("anthropic");
    });
  });

  describe("detectProviderFromEnv", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      vi.resetModules();
      process.env = { ...originalEnv };
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OLLAMA_HOST;
      delete process.env.OPENROUTER_API_KEY;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("detects openai when OPENAI_API_KEY is set", () => {
      process.env.OPENAI_API_KEY = "sk-test";
      expect(detectProviderFromEnv()).toBe("openai");
    });

    it("detects anthropic when ANTHROPIC_API_KEY is set", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      expect(detectProviderFromEnv()).toBe("anthropic");
    });

    it("detects ollama when OLLAMA_HOST is set", () => {
      process.env.OLLAMA_HOST = "http://localhost:11434";
      expect(detectProviderFromEnv()).toBe("ollama");
    });

    it("detects openrouter when OPENROUTER_API_KEY is set", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      expect(detectProviderFromEnv()).toBe("openrouter");
    });

    it("defaults to openrouter when no env vars set", () => {
      expect(detectProviderFromEnv()).toBe("openrouter");
    });

    it("prefers openai over openrouter when both are set", () => {
      process.env.OPENAI_API_KEY = "sk-test";
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      expect(detectProviderFromEnv()).toBe("openai");
    });
  });

  describe("listProviders", () => {
    it("lists all registered providers", () => {
      const providers = listProviders();
      expect(providers).toContain("openrouter");
      expect(providers).toContain("openai");
      expect(providers).toContain("anthropic");
      expect(providers).toContain("ollama");
    });
  });

  describe("isProviderRegistered", () => {
    it("returns true for registered providers", () => {
      expect(isProviderRegistered("openrouter")).toBe(true);
      expect(isProviderRegistered("openai")).toBe(true);
      expect(isProviderRegistered("anthropic")).toBe(true);
      expect(isProviderRegistered("ollama")).toBe(true);
    });

    it("returns false for unregistered providers", () => {
      expect(isProviderRegistered("unknown" as any)).toBe(false);
    });
  });

  describe("createProvider", () => {
    it("creates openrouter provider explicitly", () => {
      const provider = createProvider({ provider: "openrouter", dryRun: true });
      expect(provider.info.type).toBe("openrouter");
      expect(provider).toBeInstanceOf(OpenRouterProvider);
    });

    it("creates openai provider explicitly", () => {
      const provider = createProvider({ provider: "openai", dryRun: true });
      expect(provider.info.type).toBe("openai");
      expect(provider).toBeInstanceOf(OpenAIProvider);
    });

    it("creates anthropic provider explicitly", () => {
      const provider = createProvider({ provider: "anthropic", dryRun: true });
      expect(provider.info.type).toBe("anthropic");
      expect(provider).toBeInstanceOf(AnthropicProvider);
    });

    it("creates ollama provider explicitly", () => {
      const provider = createProvider({ provider: "ollama", dryRun: true });
      expect(provider.info.type).toBe("ollama");
      expect(provider).toBeInstanceOf(OllamaProvider);
    });

    it("auto-detects openrouter from model with slash", () => {
      const provider = createProvider({ model: "openai/gpt-4o", dryRun: true });
      expect(provider.info.type).toBe("openrouter");
    });

    it("auto-detects openai from gpt- model", () => {
      const provider = createProvider({ model: "gpt-4o", dryRun: true });
      expect(provider.info.type).toBe("openai");
    });

    it("auto-detects anthropic from claude- model", () => {
      const provider = createProvider({ model: "claude-3-opus", dryRun: true });
      expect(provider.info.type).toBe("anthropic");
    });

    it("throws for unknown provider type", () => {
      expect(() => createProvider({ provider: "unknown" as any })).toThrow("Unknown provider type");
    });
  });

  describe("OpenRouterProvider", () => {
    it("has correct provider info", () => {
      const provider = new OpenRouterProvider({ dryRun: true });
      expect(provider.info.type).toBe("openrouter");
      expect(provider.info.name).toBe("OpenRouter");
      expect(provider.info.requiresApiKey).toBe(true);
    });

    it("returns dry-run response when dryRun is true", async () => {
      const provider = new OpenRouterProvider({ dryRun: true, model: "test-model" });
      expect(provider.isDryRun).toBe(true);
      
      const response = await provider.complete({
        messages: [{ role: "user", content: "Hello" }],
      });
      
      expect(response.model).toContain("#dry-run");
      expect(response.usage?.promptTokens).toBe(0);
    });

    it("uses provided model", () => {
      const provider = new OpenRouterProvider({ model: "custom/model", dryRun: true });
      expect(provider.modelId).toBe("custom/model");
    });
  });

  describe("OpenAIProvider", () => {
    it("has correct provider info", () => {
      const provider = new OpenAIProvider({ dryRun: true });
      expect(provider.info.type).toBe("openai");
      expect(provider.info.name).toBe("OpenAI");
      expect(provider.info.requiresApiKey).toBe(true);
    });

    it("returns dry-run response when dryRun is true", async () => {
      const provider = new OpenAIProvider({ dryRun: true, model: "gpt-4o" });
      expect(provider.isDryRun).toBe(true);
      
      const response = await provider.complete({
        messages: [{ role: "user", content: "Hello" }],
      });
      
      expect(response.model).toContain("#dry-run");
    });

    it("defaults to gpt-4o-mini model", () => {
      const provider = new OpenAIProvider({ dryRun: true });
      expect(provider.modelId).toBe("gpt-4o-mini");
    });
  });

  describe("AnthropicProvider", () => {
    it("has correct provider info", () => {
      const provider = new AnthropicProvider({ dryRun: true });
      expect(provider.info.type).toBe("anthropic");
      expect(provider.info.name).toBe("Anthropic");
      expect(provider.info.requiresApiKey).toBe(true);
    });

    it("returns dry-run response when dryRun is true", async () => {
      const provider = new AnthropicProvider({ dryRun: true, model: "claude-3-opus" });
      expect(provider.isDryRun).toBe(true);
      
      const response = await provider.complete({
        messages: [{ role: "user", content: "Hello" }],
      });
      
      expect(response.model).toContain("#dry-run");
    });
  });

  describe("OllamaProvider", () => {
    it("has correct provider info", () => {
      const provider = new OllamaProvider({ dryRun: true });
      expect(provider.info.type).toBe("ollama");
      expect(provider.info.name).toBe("Ollama");
      expect(provider.info.requiresApiKey).toBe(false);
    });

    it("returns dry-run response when dryRun is true", async () => {
      const provider = new OllamaProvider({ dryRun: true, model: "llama3" });
      expect(provider.isDryRun).toBe(true);
      
      const response = await provider.complete({
        messages: [{ role: "user", content: "Hello" }],
      });
      
      expect(response.model).toContain("#dry-run");
    });

    it("defaults to localhost:11434", () => {
      const provider = new OllamaProvider({ dryRun: true });
      expect(provider.info.baseUrl).toBe("http://localhost:11434");
    });
  });

  describe("LlmProvider interface", () => {
    it("all providers implement LlmProvider interface", () => {
      const providers: LlmProvider[] = [
        new OpenRouterProvider({ dryRun: true }),
        new OpenAIProvider({ dryRun: true }),
        new AnthropicProvider({ dryRun: true }),
        new OllamaProvider({ dryRun: true }),
      ];

      for (const provider of providers) {
        expect(provider.info).toBeDefined();
        expect(provider.info.type).toBeDefined();
        expect(provider.info.name).toBeDefined();
        expect(provider.modelId).toBeDefined();
        expect(typeof provider.isDryRun).toBe("boolean");
        expect(typeof provider.complete).toBe("function");
      }
    });
  });
});
