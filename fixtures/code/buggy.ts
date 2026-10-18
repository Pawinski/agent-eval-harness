/**
 * Module with intentional bugs for patch/fix tasks.
 */

export function sumArray(arr: number[]): number {
  let total = 0;
  for (let i = 0; i <= arr.length; i++) {
    total += arr[i];
  }
  return total;
}

export function findMax(arr: number[]): number {
  if (arr.length === 0) {
    return 0;
  }
  let max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < max) {
      max = arr[i];
    }
  }
  return max;
}

export function greet(name: string): string {
  return "Hello, " + name + "?";
}
