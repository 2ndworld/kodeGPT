import { NATIVE_CAPABILITY_IDS, type NativeCapabilityId } from "./contracts.js";
import { getPublicActionDescriptor } from "./public-actions.js";

export interface NativeCapabilitySemanticMetadata {
  readonly id: NativeCapabilityId;
  readonly purpose: string;
  readonly semanticAliases: readonly string[];
}

type Registry = Readonly<Record<NativeCapabilityId, NativeCapabilitySemanticMetadata>>;

function fromPublicAction(id: NativeCapabilityId): NativeCapabilitySemanticMetadata {
  const action = getPublicActionDescriptor(id);
  return Object.freeze({
    id,
    purpose: action.purpose,
    semanticAliases: action.aliases
  });
}

export const NATIVE_CAPABILITY_SEMANTICS: Registry = Object.freeze(
  Object.fromEntries(NATIVE_CAPABILITY_IDS.map((id) => [id, fromPublicAction(id)])) as Record<
    NativeCapabilityId,
    NativeCapabilitySemanticMetadata
  >
);

export function getNativeCapabilitySemanticMetadata(
  id: NativeCapabilityId
): NativeCapabilitySemanticMetadata {
  return NATIVE_CAPABILITY_SEMANTICS[id];
}

if (Object.keys(NATIVE_CAPABILITY_SEMANTICS).length !== NATIVE_CAPABILITY_IDS.length) {
  throw new Error("Native capability semantic metadata is incomplete");
}
