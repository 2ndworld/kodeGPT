export const READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

export const WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
});

export const MUTATING_FILE_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
});

export const LOCAL_GIT_MUTATION_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
});

export const REMOTE_CI_READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
});

export const REMOTE_GITHUB_READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
});

export const REMOTE_GITHUB_CREATE_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
});

export const REMOTE_GITHUB_MERGE_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
});

export const REMOTE_GIT_FETCH_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
});

export const REMOTE_GIT_MUTATION_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
});

export const PROCESS_CONTROL_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
});

export const PROCESS_RUN_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
});

export const PROCESS_CANCEL_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
});
