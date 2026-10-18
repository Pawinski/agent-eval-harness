/**
 * Input validation utilities for fixture tests.
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateEmail(email: string): ValidationResult {
  const errors: string[] = [];
  
  if (!email || email.trim() === "") {
    errors.push("email is required");
  } else if (!email.includes("@")) {
    errors.push("email must contain @");
  } else if (email.length > 100) {
    errors.push("email too long");
  }
  
  return { valid: errors.length === 0, errors };
}

export function validateAge(age: number): ValidationResult {
  const errors: string[] = [];
  
  if (typeof age !== "number" || isNaN(age)) {
    errors.push("age must be a number");
  } else if (age < 0) {
    errors.push("age cannot be negative");
  } else if (age > 150) {
    errors.push("age exceeds maximum");
  }
  
  return { valid: errors.length === 0, errors };
}

export function processInput(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return `string:${value.length}`;
  }
  if (typeof value === "number") {
    return `number:${value}`;
  }
  return "unknown";
}
