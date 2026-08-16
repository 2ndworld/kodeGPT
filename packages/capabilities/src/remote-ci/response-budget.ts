import { CapabilityError } from "../errors.js";
import { MAX_CI_RESPONSE_BYTES } from "./contracts.js";

interface TruncatableCiResult {
  truncated: boolean;
  truncationReasons: string[];
}

export function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(codePoints.slice(0, mid).join(""), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return codePoints.slice(0, low).join("");
}

export function fitCiResult<T extends TruncatableCiResult>(value: T): T {
  if (serializedBytes(value) <= MAX_CI_RESPONSE_BYTES) return value;
  let candidate = markResponseLimit(structuredClone(value));

  candidate = fitStringField(candidate, "logExcerpt");
  if (fits(candidate)) return candidate;

  candidate = fitArrayField(candidate, "annotations");
  if (fits(candidate)) return candidate;

  candidate = fitNestedSteps(candidate);
  if (fits(candidate)) return candidate;

  for (const field of ["jobs", "failures", "checks", "runs"] as const) {
    candidate = fitArrayField(candidate, field);
    if (fits(candidate)) return candidate;
  }

  throw new CapabilityError(
    "CI_RESPONSE_LIMIT_EXCEEDED",
    "Remote-CI response exceeded the public response limit"
  );
}

function markResponseLimit<T extends TruncatableCiResult>(value: T): T {
  return {
    ...value,
    truncated: true,
    truncationReasons: value.truncationReasons.includes("RESPONSE_LIMIT")
      ? value.truncationReasons
      : [...value.truncationReasons, "RESPONSE_LIMIT"]
  };
}

function fitStringField<T extends TruncatableCiResult>(value: T, field: string): T {
  const record = value as T & Record<string, unknown>;
  const text = record[field];
  if (typeof text !== "string" || fits(value)) return value;

  let low = 0;
  let high = Buffer.byteLength(text, "utf8");
  let best = withField(value, field, "");
  if (!fits(best)) return best;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const trial = withField(value, field, utf8Prefix(text, mid));
    if (fits(trial)) {
      best = trial;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function fitArrayField<T extends TruncatableCiResult>(value: T, field: string): T {
  const record = value as T & Record<string, unknown>;
  const items = record[field];
  if (!Array.isArray(items) || items.length === 0 || fits(value)) return value;

  let low = 0;
  let high = items.length;
  let best = withField(value, field, []);
  if (!fits(best)) return best;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const trial = withField(value, field, items.slice(0, mid));
    if (fits(trial)) {
      best = trial;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function fitNestedSteps<T extends TruncatableCiResult>(value: T): T {
  const record = value as T & Record<string, unknown>;
  if (!Array.isArray(record.jobs) || fits(value)) return value;
  const jobs = record.jobs;
  const stepCounts = jobs.map((job) => {
    if (typeof job !== "object" || job === null || Array.isArray(job)) return 0;
    const steps = (job as Record<string, unknown>).steps;
    return Array.isArray(steps) ? steps.length : 0;
  });
  const totalSteps = stepCounts.reduce((sum, count) => sum + count, 0);
  if (totalSteps === 0) return value;

  let low = 0;
  let high = totalSteps;
  let best = withStepsPrefix(value, 0);
  if (!fits(best)) return best;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const trial = withStepsPrefix(value, mid);
    if (fits(trial)) {
      best = trial;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function withStepsPrefix<T extends TruncatableCiResult>(value: T, keep: number): T {
  const record = value as T & Record<string, unknown>;
  const jobs = Array.isArray(record.jobs) ? record.jobs : [];
  let remaining = keep;
  const nextJobs = jobs.map((job) => {
    if (typeof job !== "object" || job === null || Array.isArray(job)) return job;
    const jobRecord = job as Record<string, unknown>;
    if (!Array.isArray(jobRecord.steps)) return job;
    const count = Math.min(remaining, jobRecord.steps.length);
    remaining -= count;
    return { ...jobRecord, steps: jobRecord.steps.slice(0, count) };
  });
  return withField(value, "jobs", nextJobs);
}

function withField<T extends TruncatableCiResult>(value: T, field: string, fieldValue: unknown): T {
  return { ...(value as T & Record<string, unknown>), [field]: fieldValue } as T;
}

function fits(value: unknown): boolean {
  return serializedBytes(value) <= MAX_CI_RESPONSE_BYTES;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
