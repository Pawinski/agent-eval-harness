import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getCacheBreakpointEnabled,
  resetDeprecationWarning,
  NEW_VAR_NAME,
  LEGACY_VAR_NAME,
} from "../cache-breakpoint.js";

describe("getCacheBreakpointEnabled", () => {
  beforeEach(() => {
    resetDeprecationWarning();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns enabled=true with source=new when new var is set to 1", () => {
    const env = { [NEW_VAR_NAME]: "1" };
    const result = getCacheBreakpointEnabled(env);
    expect(result).toEqual({ enabled: true, source: "new" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns enabled=false with source=new when new var is set but not 1", () => {
    const env = { [NEW_VAR_NAME]: "0" };
    const result = getCacheBreakpointEnabled(env);
    expect(result).toEqual({ enabled: false, source: "new" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns enabled=true with source=legacy when only legacy var is 1 and warns once", () => {
    const env = { [LEGACY_VAR_NAME]: "1" };

    const result1 = getCacheBreakpointEnabled(env);
    expect(result1).toEqual({ enabled: true, source: "legacy" });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("deprecated"),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(NEW_VAR_NAME),
    );

    const result2 = getCacheBreakpointEnabled(env);
    expect(result2).toEqual({ enabled: true, source: "legacy" });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("returns enabled=false with source=legacy when legacy var is set but not 1 and warns", () => {
    const env = { [LEGACY_VAR_NAME]: "0" };

    const result = getCacheBreakpointEnabled(env);
    expect(result).toEqual({ enabled: false, source: "legacy" });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("new var wins when both are set (no warning)", () => {
    const env = { [NEW_VAR_NAME]: "1", [LEGACY_VAR_NAME]: "0" };
    const result = getCacheBreakpointEnabled(env);
    expect(result).toEqual({ enabled: true, source: "new" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns enabled=false with source=none when neither var is set", () => {
    const env = {};
    const result = getCacheBreakpointEnabled(env);
    expect(result).toEqual({ enabled: false, source: "none" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("deprecation warning is only printed once even across multiple reads", () => {
    const env = { [LEGACY_VAR_NAME]: "1" };

    getCacheBreakpointEnabled(env);
    getCacheBreakpointEnabled(env);
    getCacheBreakpointEnabled(env);

    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("resetDeprecationWarning allows warning to be printed again", () => {
    const env = { [LEGACY_VAR_NAME]: "1" };

    getCacheBreakpointEnabled(env);
    expect(console.error).toHaveBeenCalledTimes(1);

    resetDeprecationWarning();
    getCacheBreakpointEnabled(env);
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});
