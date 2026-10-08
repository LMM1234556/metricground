export type IndependentVerificationCheck = {
  label: string;
  passed: boolean;
  detail: string;
};

export type IndependentVerification = {
  engine: "duckdb-wasm";
  engineVersion: string;
  status: "passed" | "failed" | "error";
  datasetVersionId: string;
  durationMs: number;
  query: string;
  checks: IndependentVerificationCheck[];
  referenceValue: number | null;
  referenceRows: Array<{ key: string; value: number }>;
  error: string | null;
};

export function approximatelyEqual(left: number | null, right: number | null) {
  if (left === null || right === null) return left === right;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const tolerance = Math.max(1e-9, Math.abs(left) * 1e-9, Math.abs(right) * 1e-9);
  return Math.abs(left - right) <= tolerance;
}

export function verificationPassed(checks: IndependentVerificationCheck[]) {
  return checks.length > 0 && checks.every((check) => check.passed);
}
