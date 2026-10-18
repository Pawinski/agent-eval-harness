/**
 * Centralized redaction for sensitive values.
 * Ensures API keys and Bearer tokens never appear in output or logs.
 */

const REDACTED = "[REDACTED]";

let sensitiveValues: string[] = [];

export function registerSensitiveValue(value: string): void {
  if (value && value.length > 0 && !sensitiveValues.includes(value)) {
    sensitiveValues.push(value);
  }
}

export function clearSensitiveValues(): void {
  sensitiveValues = [];
}

export function redactString(input: string): string {
  if (!input) return input;

  let result = input;

  for (const sensitive of sensitiveValues) {
    if (sensitive && result.includes(sensitive)) {
      result = result.split(sensitive).join(REDACTED);
    }
  }

  result = result.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, `Bearer ${REDACTED}`);

  return result;
}

export function redactObject<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    return redactString(obj) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item)) as T;
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = redactObject(value);
    }
    return result as T;
  }

  return obj;
}

export function redactError(err: unknown): Error {
  if (err instanceof Error) {
    const redactedMessage = redactString(err.message);
    const redactedStack = err.stack ? redactString(err.stack) : undefined;

    const redactedError = new Error(redactedMessage);
    if (redactedStack) {
      redactedError.stack = redactedStack;
    }
    redactedError.name = err.name;

    return redactedError;
  }

  if (typeof err === "string") {
    return new Error(redactString(err));
  }

  return new Error(redactString(String(err)));
}

export function safeStringify(obj: unknown, indent?: number): string {
  const redacted = redactObject(obj);
  return JSON.stringify(redacted, null, indent);
}
