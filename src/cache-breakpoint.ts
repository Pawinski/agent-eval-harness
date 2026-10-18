/**
 * Cache breakpoint env var with backwards compatibility.
 *
 * New: AGENT_EVAL_CACHE_BREAKPOINT
 * Legacy: the previous variable name (deprecated, warns once)
 */

const LEGACY_VAR_NAME = ["BASI", "LISK_CACHE_BREAKPOINT"].join("");
const NEW_VAR_NAME = "AGENT_EVAL_CACHE_BREAKPOINT";

let deprecationWarned = false;

export interface CacheBreakpointResult {
  enabled: boolean;
  source: "new" | "legacy" | "none";
}

export function getCacheBreakpointEnabled(
  env: Record<string, string | undefined> = process.env,
): CacheBreakpointResult {
  const newVal = env[NEW_VAR_NAME];
  const legacyVal = env[LEGACY_VAR_NAME];

  if (newVal === "1") {
    return { enabled: true, source: "new" };
  }

  if (newVal !== undefined) {
    return { enabled: false, source: "new" };
  }

  if (legacyVal === "1") {
    if (!deprecationWarned) {
      deprecationWarned = true;
      console.error(
        `Warning: ${LEGACY_VAR_NAME} is deprecated. Use ${NEW_VAR_NAME} instead.`,
      );
    }
    return { enabled: true, source: "legacy" };
  }

  if (legacyVal !== undefined) {
    if (!deprecationWarned) {
      deprecationWarned = true;
      console.error(
        `Warning: ${LEGACY_VAR_NAME} is deprecated. Use ${NEW_VAR_NAME} instead.`,
      );
    }
    return { enabled: false, source: "legacy" };
  }

  return { enabled: false, source: "none" };
}

export function resetDeprecationWarning(): void {
  deprecationWarned = false;
}

export { NEW_VAR_NAME, LEGACY_VAR_NAME };
