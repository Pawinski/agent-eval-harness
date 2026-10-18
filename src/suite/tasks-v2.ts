/**
 * Suite 0.2.0 tasks: 16 tasks across 6 categories.
 * All deterministic checks. No LLM judge.
 * Prompts do NOT name tools or arguments.
 */

import type { CheckSpec } from "./checkers.js";

export type SuiteTaskV2 = {
  id: string;
  description: string;
  prompt: string;
  expectedTools?: string[];
  check: CheckSpec;
  fixtureAnswer?: string;
  maxSteps?: number;
  category: "chain" | "selection" | "code_read" | "patch" | "data" | "error_recovery";
};

export const TASKS_V2: SuiteTaskV2[] = [
  // ============================================
  // MULTI-STEP TOOL CHAINING (3 tasks)
  // ============================================
  {
    id: "chain_json_regex_add",
    category: "chain",
    description: "Extract a value from JSON, apply regex, then add numbers.",
    prompt: `You have access to tools for parsing JSON, extracting patterns, and arithmetic.
Given the JSON string: {"order":"INV-2024-0042","amount":150}
1. Extract the "order" field value
2. Extract just the numeric ID from that order string (the digits after the last hyphen)
3. Add that number to the amount field value
Report only the final sum as a plain integer.`,
    check: { kind: "exact", expected: "192" },
    fixtureAnswer: "192",
    maxSteps: 8,
  },
  {
    id: "chain_word_count_multiply",
    category: "chain",
    description: "Count words then multiply by a factor.",
    prompt: `You have access to tools for counting words and arithmetic.
Given the text: "The quick brown fox jumps over the lazy dog"
1. Count the number of words
2. Multiply that count by 7
Report only the final product as a plain integer.`,
    check: { kind: "exact", expected: "63" },
    fixtureAnswer: "63",
    maxSteps: 8,
  },
  {
    id: "chain_extract_sum",
    category: "chain",
    description: "Extract two numbers from text and sum them.",
    prompt: `You have access to tools for pattern extraction and arithmetic.
Given the text: "Order total: $45.00, Shipping: $12.00"
1. Extract the first dollar amount (just digits, no decimal)
2. Extract the second dollar amount (just digits, no decimal)
3. Add them together
Report only the final sum as a plain integer.`,
    check: { kind: "exact", expected: "57" },
    fixtureAnswer: "57",
    maxSteps: 8,
  },

  // ============================================
  // TOOL SELECTION (3 tasks)
  // ============================================
  {
    id: "select_echo_tool",
    category: "selection",
    description: "Select the right tool from the full catalog to echo text.",
    prompt: `You have access to many tools. Pick the appropriate one.
Echo back the exact text "hello-world" and report that text as your final answer.`,
    expectedTools: undefined,
    check: { kind: "exact", expected: "hello-world" },
    fixtureAnswer: "hello-world",
    maxSteps: 6,
  },
  {
    id: "select_add_tool",
    category: "selection",
    description: "Select the right tool from the full catalog to add numbers.",
    prompt: `You have access to many tools. Pick the appropriate one.
Compute 123 + 456 and report only the numeric result.`,
    expectedTools: undefined,
    check: { kind: "exact", expected: "579" },
    fixtureAnswer: "579",
    maxSteps: 6,
  },
  {
    id: "select_json_tool",
    category: "selection",
    description: "Select the right tool from the full catalog to parse JSON.",
    prompt: `You have access to many tools. Pick the appropriate one.
From the JSON object {"status":"active","count":42}, extract the value of the "status" key.
Report only that value.`,
    expectedTools: undefined,
    check: { kind: "exact", expected: "active" },
    fixtureAnswer: "active",
    maxSteps: 6,
  },

  // ============================================
  // CODE READING (3 tasks)
  // ============================================
  {
    id: "code_compute_result",
    category: "code_read",
    description: "Read code and determine what a function returns for a given input.",
    prompt: `Read the file code/calculator.ts and analyze the compute function.
What value does compute(7) return?
Report only the numeric result.`,
    expectedTools: ["read_file"],
    check: { kind: "exact", expected: "24" },
    fixtureAnswer: "24",
    maxSteps: 6,
  },
  {
    id: "code_find_throw",
    category: "code_read",
    description: "Read code and find which line throws an error.",
    prompt: `Read the file code/calculator.ts and find the line number where the factorial function throws an error for negative input.
Report only the line number as an integer.`,
    expectedTools: ["read_file"],
    check: { kind: "exact", expected: "24" },
    fixtureAnswer: "24",
    maxSteps: 6,
  },
  {
    id: "code_validate_email",
    category: "code_read",
    description: "Read code and determine validation behavior.",
    prompt: `Read the file code/validator.ts and analyze the validateEmail function.
What error message is added when the email does not contain an @ symbol?
Report only the exact error string.`,
    expectedTools: ["read_file"],
    check: { kind: "exact", expected: "email must contain @" },
    fixtureAnswer: "email must contain @",
    maxSteps: 6,
  },

  // ============================================
  // PATCH/DIFF REASONING (3 tasks)
  // ============================================
  {
    id: "patch_sum_array",
    category: "patch",
    description: "Fix an off-by-one bug in sumArray function.",
    prompt: `The file code/buggy.ts contains a sumArray function with a bug.
The loop condition causes an array index out-of-bounds error.
Fix the bug by patching the file, then run the sum_array check.
Report "fixed" if the check passes (exit 0), otherwise report "failed".`,
    expectedTools: ["read_file", "apply_patch", "run_check"],
    check: { kind: "exact", expected: "fixed" },
    fixtureAnswer: "fixed",
    maxSteps: 10,
  },
  {
    id: "patch_find_max",
    category: "patch",
    description: "Fix an inverted comparison in findMax function.",
    prompt: `The file code/buggy.ts contains a findMax function that returns the minimum instead of maximum.
The comparison operator is wrong.
Fix the bug by patching the file, then run the find_max check.
Report "fixed" if the check passes (exit 0), otherwise report "failed".`,
    expectedTools: ["read_file", "apply_patch", "run_check"],
    check: { kind: "exact", expected: "fixed" },
    fixtureAnswer: "fixed",
    maxSteps: 10,
  },
  {
    id: "patch_greet",
    category: "patch",
    description: "Fix wrong punctuation in greet function.",
    prompt: `The file code/buggy.ts contains a greet function that uses a question mark instead of an exclamation mark.
Fix the punctuation by patching the file, then run the greet check.
Report "fixed" if the check passes (exit 0), otherwise report "failed".`,
    expectedTools: ["read_file", "apply_patch", "run_check"],
    check: { kind: "exact", expected: "fixed" },
    fixtureAnswer: "fixed",
    maxSteps: 10,
  },

  // ============================================
  // DATA TRANSFORM (2 tasks)
  // ============================================
  {
    id: "data_inventory_sum",
    category: "data",
    description: "Filter CSV and compute aggregate.",
    prompt: `Query the CSV file data/inventory.csv.
Filter to only rows where category equals "electronics".
Compute the sum of the quantity column for those rows.
Report only the JSON object with the sum, like {"sum":N}.`,
    expectedTools: ["csv_query"],
    check: { kind: "json_equal", expected: { sum: 290 } },
    fixtureAnswer: '{"sum":290}',
    maxSteps: 6,
  },
  {
    id: "data_weather_avg",
    category: "data",
    description: "Filter CSV and compute average.",
    prompt: `Query the CSV file data/weather.csv.
Filter to only rows where city equals "Warsaw".
Compute the average of the temp_c column for those rows.
Report only the JSON object with the average rounded to 2 decimal places, like {"avg":N}.`,
    expectedTools: ["csv_query"],
    check: { kind: "json_equal", expected: { avg: 1.33 } },
    fixtureAnswer: '{"avg":1.33}',
    maxSteps: 6,
  },

  // ============================================
  // ERROR RECOVERY (2 tasks)
  // ============================================
  {
    id: "error_recovery_sum",
    category: "error_recovery",
    description: "Retry after transient error on sum operation.",
    prompt: `Use the flaky_sum tool to compute 25 + 17.
The tool may return an error on the first attempt. If it does, retry with the same arguments.
Report only the final numeric result.`,
    expectedTools: ["flaky_sum"],
    check: { kind: "exact", expected: "42" },
    fixtureAnswer: "42",
    maxSteps: 8,
  },
  {
    id: "error_recovery_lookup",
    category: "error_recovery",
    description: "Retry after transient error on lookup operation.",
    prompt: `Use the flaky_lookup tool to look up the product name for SKU "SKU-200".
The tool may return an error on the first attempt. If it does, retry with the same arguments.
Report only the product name.`,
    expectedTools: ["flaky_lookup"],
    check: { kind: "exact", expected: "Widget Premium" },
    fixtureAnswer: "Widget Premium",
    maxSteps: 8,
  },
];

export function getTaskV2(id: string): SuiteTaskV2 | undefined {
  return TASKS_V2.find((t) => t.id === id);
}

export function listTaskV2Ids(): string[] {
  return TASKS_V2.map((t) => t.id);
}

export function getTasksByCategory(category: SuiteTaskV2["category"]): SuiteTaskV2[] {
  return TASKS_V2.filter((t) => t.category === category);
}
