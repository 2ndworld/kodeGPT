export const STATE_SCHEMA_VERSION = 1 as const;

export interface StateEnvelope<T> {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  data: T;
}

export function assertStateVersion(
  value: { schemaVersion?: unknown }
): asserts value is { schemaVersion: 1 } {
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`UNSUPPORTED_STATE_SCHEMA:${String(value.schemaVersion)}`);
  }
}
