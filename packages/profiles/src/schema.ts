import {
  runtimePolicySchema,
  type RuntimePolicy
} from "@kodegpt/protocol";

export const profilePolicySchema = runtimePolicySchema;
export const profileNameSchema = profilePolicySchema.shape.name;
export const networkModeSchema = profilePolicySchema.shape.network;

export type ProfilePolicy = RuntimePolicy;
export type ProfileName = RuntimePolicy["name"];
export type NetworkMode = RuntimePolicy["network"];
