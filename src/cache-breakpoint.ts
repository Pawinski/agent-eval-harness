/**
 * Cache breakpoint env var.
 *
 * AGENT_EVAL_CACHE_BREAKPOINT=1 enables cache_control ephemeral on system messages.
 */

const ENV_VAR_NAME = "AGENT_EVAL_CACHE_BREAKPOINT";

export interface CacheBreakpointResult {
  enabled: boolean;
  source: "new" | "none";
}

export function getCacheBreakpointEnabled(
  env: Record<string, string | undefined> = process.env,
): CacheBreakpointResult {
  const val = env[ENV_VAR_NAME];

  if (val === "1") {
    return { enabled: true, source: "new" };
  }

  if (val !== undefined) {
    return { enabled: false, source: "new" };
  }

  return { enabled: false, source: "none" };
}

export { ENV_VAR_NAME as NEW_VAR_NAME };
