/**
 * Simple calculator module for fixture tests.
 */

export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function compute(x: number): number {
  if (x < 0) {
    throw new Error("negative input");
  }
  const doubled = x * 2;
  const result = doubled + 10;
  return result;
}

// Factorial implementation
export function factorial(n: number): number {
  if (n < 0) {
    throw new Error("negative input");
  }
  if (n === 0 || n === 1) {
    return 1;
  }
  return n * factorial(n - 1);
}
