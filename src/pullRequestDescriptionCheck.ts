import { fileURLToPath } from "node:url";

export const requiredHeadings = [
  "**TL;DR:**",
  "Filed by:",
  "## Why",
  "## What changed",
  "## Deleted / simplified",
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

function sectionLinesAfter(lines: string[], headingLine: number): string[] {
  const after = lines.slice(headingLine + 1);
  const nextHeading = after.findIndex((line) => /^#{1,6}\s/.test(line.trim()));
  return nextHeading === -1 ? after : after.slice(0, nextHeading);
}

function normalizeSectionLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^`+|`+$/g, "")
    .trim();
}

function isBareNone(text: string): boolean {
  return /^none\.?$/i.test(text);
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

  const whyHeadingIndex = requiredHeadings.indexOf("## Why");
  const whyLine = positions[whyHeadingIndex];
  if (whyLine !== -1) {
    const whyText = sectionLinesAfter(lines, whyLine).join("").trim();
    if (whyText === "") problems.push("The Why section is empty.");
  }

  const deletedHeadingIndex = requiredHeadings.indexOf("## Deleted / simplified");
  const deletedLine = positions[deletedHeadingIndex];
  if (deletedLine !== -1) {
    const deletedLines = sectionLinesAfter(lines, deletedLine);
    const deletedText = deletedLines.join("").trim();
    if (deletedText === "") {
      problems.push("The Deleted / simplified section is empty.");
    } else {
      const contentLines = deletedLines.map((line) => line.trim()).filter((line) => line !== "");
      const normalizedLines = contentLines.map((line) => normalizeSectionLine(line));
      if (normalizedLines.every((line) => isBareNone(line))) {
        problems.push('The Deleted / simplified section is a bare "none".');
      }
      const normalizedBlock = normalizedLines.join("\n");
      if (/^Nothing deleted:\s*$/i.test(normalizedBlock)) {
        problems.push('The Deleted / simplified section needs a reason after "Nothing deleted:".');
      }
    }
  }

  for (const line of lines) {
    const match = line.match(/UI:\s*none(.*)$/i);
    if (!match) continue;
    const reason = match[1].replace(/`/g, "").replace(/^[\s—–:-]+/, "").trim();
    if (reason === "") problems.push(`"UI: none" needs a reason, for example "UI: none — docs only".`);
  }
  const costHeadingIndex = requiredHeadings.indexOf("## Cost");
  const costLine = positions[costHeadingIndex];
  if (costLine !== -1) {
    const costRows = lines.slice(costLine + 1).map((line) => line.trim().toLowerCase());
    if (!costRows.some((row) => row.startsWith("| usage cost"))) {
      problems.push("The Cost table is missing the Usage cost ($) row.");
    }
    if (!costRows.some((row) => row.startsWith("| financial impact"))) {
      problems.push("The Cost table is missing the Financial impact ($) row.");
    }
    for (const row of costRows) {
      if (!row.startsWith("| usage cost") && !row.startsWith("| financial impact")) continue;
      const cells = row.split("|").slice(2, -1).map((cell) => cell.trim());
      if (cells.some((cell) => cell === "" || /^n\/a[\s:—–-]*$/.test(cell))) {
        problems.push(`A dollar row is blank or a bare "n/a" with no reason: ${row}`);
      }
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
