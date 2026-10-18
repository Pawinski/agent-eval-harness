/**
 * Thin MCP tool client stubs / interface.
 * Tools the ReAct agent can call. Real MCP transport can replace this later;
 * MVP uses in-process handlers for deterministic suite fixtures.
 */

export type McpToolSchema = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
};

export type McpToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type McpToolResult = {
  ok: boolean;
  content: string;
  /** Structured payload when the tool returns JSON-ish data. */
  data?: unknown;
  error?: string;
};

export interface McpToolClient {
  listTools(): Promise<McpToolSchema[]>;
  callTool(call: McpToolCall): Promise<McpToolResult>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult;

export type InProcessMcpOptions = {
  tools: Array<McpToolSchema & { handler: ToolHandler }>;
};

/**
 * In-process MCP-shaped tool registry (stub transport).
 * Swap for a real MCP stdio/SSE client without changing the agent loop.
 */
export class InProcessMcpClient implements McpToolClient {
  private readonly registry: Map<string, { schema: McpToolSchema; handler: ToolHandler }>;

  constructor(opts: InProcessMcpOptions) {
    this.registry = new Map();
    for (const t of opts.tools) {
      const { handler, ...schema } = t;
      this.registry.set(schema.name, { schema, handler });
    }
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [...this.registry.values()].map((v) => v.schema);
  }

  async callTool(call: McpToolCall): Promise<McpToolResult> {
    const entry = this.registry.get(call.name);
    if (!entry) {
      return {
        ok: false,
        content: "",
        error: `Unknown tool: ${call.name}`,
      };
    }
    try {
      return await entry.handler(call.arguments ?? {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, content: "", error: msg };
    }
  }
}

type ToolDefinition = McpToolSchema & { handler: ToolHandler };

/** Default built-in tool definitions used by the frozen suite fixtures. */
export function getDefaultToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "echo",
      description: "Echo back the input string.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (args) => ({
        ok: true,
        content: String(args.text ?? ""),
      }),
    },
    {
      name: "add",
      description: "Add two numbers a + b.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      handler: (args) => {
        const a = Number(args.a);
        const b = Number(args.b);
        if (Number.isNaN(a) || Number.isNaN(b)) {
          return { ok: false, content: "", error: "a and b must be numbers" };
        }
        const sum = a + b;
        return { ok: true, content: String(sum), data: { sum } };
      },
    },
    {
      name: "json_get",
      description: "Parse JSON string and get a top-level key.",
      inputSchema: {
        type: "object",
        properties: { json: { type: "string" }, key: { type: "string" } },
        required: ["json", "key"],
      },
      handler: (args) => {
        try {
          const obj = JSON.parse(String(args.json)) as Record<string, unknown>;
          const key = String(args.key);
          if (!(key in obj)) {
            return { ok: false, content: "", error: `missing key: ${key}` };
          }
          const val = obj[key];
          const content = typeof val === "string" ? val : JSON.stringify(val);
          return { ok: true, content, data: val };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, content: "", error: msg };
        }
      },
    },
    {
      name: "regex_extract",
      description: "Extract first regex match group from text (pattern with one capture).",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" }, pattern: { type: "string" } },
        required: ["text", "pattern"],
      },
      handler: (args) => {
        try {
          const re = new RegExp(String(args.pattern));
          const m = String(args.text).match(re);
          if (!m) {
            return { ok: false, content: "", error: "no match" };
          }
          const content = m[1] ?? m[0];
          return { ok: true, content };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, content: "", error: msg };
        }
      },
    },
    {
      name: "word_count",
      description: "Count whitespace-separated words in text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (args) => {
        const text = String(args.text ?? "").trim();
        const n = text === "" ? 0 : text.split(/\s+/).length;
        return { ok: true, content: String(n), data: { count: n } };
      },
    },
  ];
}

/** Default built-in tools used by the frozen suite fixtures. */
export function createDefaultMcpClient(): InProcessMcpClient {
  return new InProcessMcpClient({
    tools: getDefaultToolDefinitions(),
  });
}
