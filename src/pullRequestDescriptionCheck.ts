import { fileURLToPath } from "node:url";

export const requiredHeadings = [
  "**TL;DR:**",
  "Filed by:",
  "## Why",
  "## What changed",
  "## Proof",
  "## Risk and veto",
  "## Cost",
];

function findHeadingLine(lines: string[], heading: string): number {
  return lines.findIndex((line) => {
    const trimmed = line.trim();
    return heading.startsWith("## ") ? trimmed === heading : trimmed.startsWith(heading);
  });
}

/** Returns a list of problems; an empty list means the description passes. */
export function checkPullRequestDescription(body: string): string[] {
  const problems: string[] = [];
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const positions = requiredHeadings.map((heading) => findHeadingLine(lines, heading));

  requiredHeadings.forEach((heading, index) => {
    if (positions[index] === -1) problems.push(`Missing heading: ${heading}`);
  });
  let previous = -1;
  requiredHeadings.forEach((heading, index) => {
    const position = positions[index];
    if (position === -1) return;
    if (position < previous) problems.push(`Heading out of order: ${heading}`);
    previous = Math.max(previous, position);
  });

  const whyLine = positions[2];
  if (whyLine !== -1) {
    const after = lines.slice(whyLine + 1);
    const nextHeading = after.findIndex((line) => /^#{1,6}\s/.test(line.trim()));
    const whyText = (nextHeading === -1 ? after : after.slice(0, nextHeading)).join("").trim();
    if (whyText === "") problems.push("The Why section is empty.");
  }

  for (const line of lines) {
    const match = line.match(/UI:\s*none(.*)$/i);
    if (!match) continue;
    const reason = match[1].replace(/`/g, "").replace(/^[\s—–:-]+/, "").trim();
    if (reason === "") problems.push(`"UI: none" needs a reason, for example "UI: none — docs only".`);
  }
  const costLine = positions[6];
  if (costLine !== -1) {
    const costRows = lines.slice(costLine + 1).map((line) => line.trim().toLowerCase());
    if (!costRows.some((row) => row.startsWith("| usage cost"))) {
      problems.push("The Cost table is missing the Usage cost ($) row.");
    }
    if (!costRows.some((row) => row.startsWith("| financial impact"))) {
      problems.push("The Cost table is missing the Financial impact ($) row.");
    }
  }
  const firstHeading = Math.min(...positions.filter((position) => position !== -1));
  if (Number.isFinite(firstHeading)) {
    lines.slice(firstHeading).forEach((line, index) => {
      if (/<[^<>\n]+>/.test(line)) {
        problems.push(`Unfilled <...> placeholder on line ${firstHeading + index + 1}: ${line.trim()}`);
      }
    });
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkPullRequestDescription(process.env.PULL_REQUEST_BODY ?? "");
  if (problems.length > 0) {
    console.error("Pull request description check failed:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log("Pull request description check passed.");
}
