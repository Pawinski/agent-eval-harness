import { describe, it, expect } from "vitest";
import { checkPullRequestDescription } from "../pullRequestDescriptionCheck.js";

const validBody = [
  "**TL;DR:** Adds a thing.",
  "",
  "Filed by: SagayaBot, via LinusBot, Mon 2 Nov 2026 9:30 AM ET, while testing.",
  "",
  "## Why",
  "It fixes a real problem.",
  "",
  "## What changed",
  "- a file",
  "",
  "## Proof",
  "`UI: none — docs only`",
  "",
  "## Risk and veto",
  "- Secret scan: 0 hits",
  "",
  "## Cost",
  "| Tokens | 1k | 1k |",
  "| Usage cost ($) | 0.10 | 0.10 |",
  "| Financial impact ($) | 0, docs only | n/a until known |",
].join("\n");

describe("checkPullRequestDescription", () => {
  it("passes a complete description", () => {
    expect(checkPullRequestDescription(validBody)).toEqual([]);
  });
  it("fails when a heading is missing", () => {
    const problems = checkPullRequestDescription(validBody.replace("## Proof\n", ""));
    expect(problems).toContain("Missing heading: ## Proof");
  });
  it("fails when headings are out of order", () => {
    const swapped = validBody.replace("## What changed", "## TEMP").replace("## Why", "## What changed").replace("## TEMP", "## Why");
    expect(checkPullRequestDescription(swapped).some((problem) => problem.startsWith("Heading out of order"))).toBe(true);
  });
  it("fails when the Why section is empty", () => {
    const problems = checkPullRequestDescription(validBody.replace("It fixes a real problem.", ""));
    expect(problems).toContain("The Why section is empty.");
  });
  it("fails on a bare UI: none", () => {
    const problems = checkPullRequestDescription(validBody.replace("`UI: none — docs only`", "UI: none"));
    expect(problems.some((problem) => problem.includes("needs a reason"))).toBe(true);
  });
  it("passes UI: none with a reason", () => {
    expect(checkPullRequestDescription(validBody.replace("`UI: none — docs only`", "UI: none — reason"))).toEqual([]);
  });
  it("fails when the Usage cost row is missing", () => {
    const problems = checkPullRequestDescription(validBody.replace("| Usage cost ($) | 0.10 | 0.10 |\n", ""));
    expect(problems).toContain("The Cost table is missing the Usage cost ($) row.");
  });
  it("fails when the Financial impact row is missing", () => {
    const problems = checkPullRequestDescription(validBody.replace("\n| Financial impact ($) | 0, docs only | n/a until known |", ""));
    expect(problems).toContain("The Cost table is missing the Financial impact ($) row.");
  });
  it("fails on a placeholder left in the Why section", () => {
    const problems = checkPullRequestDescription(validBody.replace("It fixes a real problem.", "<The user or product problem this solves.>"));
    expect(problems.some((problem) => problem.startsWith("Unfilled <...> placeholder"))).toBe(true);
  });
  it("fails on a placeholder left in a Cost row", () => {
    const problems = checkPullRequestDescription(validBody.replace("| Tokens | 1k | 1k |", "| Tokens | <range> | <measured> |"));
    expect(problems.some((problem) => problem.startsWith("Unfilled <...> placeholder"))).toBe(true);
  });
});
