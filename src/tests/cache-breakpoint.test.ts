import { describe, it, expect } from "vitest";
import { getCacheBreakpointEnabled, NEW_VAR_NAME } from "../cache-breakpoint.js";

describe("getCacheBreakpointEnabled", () => {
  it("returns enabled=true with source=new when var is set to 1", () => {
    const env = { [NEW_VAR_NAME]: "1" };
    const result = getCacheBreakpointEnabled(env);
    expect(result).toEqual({ enabled: true, source: "new" });
  });

  it("returns enabled=false with source=new when var is set but not 1", () => {
    const env = { [NEW_VAR_NAME]: "0" };
    const result = getCacheBreakpointEnabled(env);
    expect(result).toEqual({ enabled: false, source: "new" });
  });

  it("returns enabled=false with source=none when var is not set", () => {
    const env = {};
    const result = getCacheBreakpointEnabled(env);
    expect(result).toEqual({ enabled: false, source: "none" });
  });

  it("treats empty string as set but not 1", () => {
    const env = { [NEW_VAR_NAME]: "" };
    const result = getCacheBreakpointEnabled(env);
    expect(result).toEqual({ enabled: false, source: "new" });
  });
});
