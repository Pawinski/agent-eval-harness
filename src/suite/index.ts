export { runCheck, type CheckKind, type CheckResult, type CheckSpec } from "./checkers.js";
export {
  getTaskV2,
  listTaskV2Ids,
  TASKS_V2,
  getTasksByCategory,
  type SuiteTaskV2,
} from "./tasks-v2.js";

import type { CheckSpec } from "./checkers.js";

export type SuiteTask = {
  id: string;
  description: string;
  prompt: string;
  expectedTools?: string[];
  check: CheckSpec;
  fixtureAnswer?: string;
};

export { getSuiteVersionPath, SUITE_VERSION } from "./version.js";
