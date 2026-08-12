import { isAbsolute, resolve } from "node:path";

import { KernelRpcError, type KernelClient } from "@kodegpt/core";
import { z } from "zod";

import {
  MAX_SOURCE_ENTRIES,
  type SkillSourceReadResult,
  type SkillSourceRootInspection,
  type SkillSourceRuntimeAdapter,
  type SkillSourceTreeResult
} from "./contracts.js";
import { SkillError, type SkillErrorCode } from "./errors.js";

const sourceRuntimeErrorCodes = new Set<SkillErrorCode>([
  "SKILL_SOURCE_INVALID",
  "SKILL_SOURCE_STATE_OVERLAP",
  "SKILL_SOURCE_IDENTITY_CHANGED",
  "SKILL_SOURCE_UNAVAILABLE",
  "SKILL_SOURCE_BOUNDARY_VIOLATION",
  "SKILL_SOURCE_LIMIT_EXCEEDED",
  "SKILL_RESOURCE_UNSUPPORTED"
]);

const identitySchema = z
  .object({
    deviceMajor: z.number().int().nonnegative().safe(),
    deviceMinor: z.number().int().nonnegative().safe(),
    inode: z.string().regex(/^\d+$/)
  })
  .strict();

const inspectionSchema = z
  .object({
    canonicalRoot: z
      .string()
      .startsWith("/")
      .refine((value) => resolve(value) === value),
    identity: identitySchema
  })
  .strict();

const registrationSchema = z
  .object({
    sourceCapabilityId: z.string().regex(/^sc_[A-Za-z0-9_-]{1,93}$/)
  })
  .strict();

const treeEntrySchema = z
  .object({
    path: z.string().min(1).refine(isCanonicalRelativePath),
    kind: z.enum(["file", "directory", "symlink", "other"]),
    sizeBytes: z.number().int().nonnegative().safe()
  })
  .strict();

const treeSchema = z
  .object({
    entries: z.array(treeEntrySchema).max(MAX_SOURCE_ENTRIES),
    truncated: z.boolean()
  })
  .strict();

const readSchema = z
  .object({
    contents: z.string(),
    bytesRead: z.number().int().nonnegative().safe(),
    eof: z.boolean()
  })
  .strict();

const unregisterSchema = z.object({ ok: z.literal(true) }).strict();

export function createSkillSourceRuntimeAdapter(
  kernel: Pick<KernelClient, "request">
): SkillSourceRuntimeAdapter {
  return {
    async inspectRoot(path): Promise<SkillSourceRootInspection> {
      const value = await request(kernel, "skill_source.inspect_root", { path });
      return parseResponse(inspectionSchema, value);
    },

    async register(input): Promise<{ sourceCapabilityId: string }> {
      const value = await request(kernel, "skill_source.register", {
        rootPath: input.rootPath,
        expectedIdentity: input.expectedIdentity
      });
      return parseResponse(registrationSchema, value);
    },

    async tree(input): Promise<SkillSourceTreeResult> {
      const value = await request(kernel, "skill_source.tree", {
        sourceCapabilityId: input.sourceCapabilityId,
        path: input.path,
        maxEntries: input.maxEntries
      });
      return parseResponse(treeSchema, value);
    },

    async read(input): Promise<SkillSourceReadResult> {
      const value = await request(kernel, "skill_source.read", {
        sourceCapabilityId: input.sourceCapabilityId,
        path: input.path,
        offset: input.offset,
        maxBytes: input.maxBytes
      });
      const parsed = parseResponse(readSchema, value);
      const actualBytes = Buffer.byteLength(parsed.contents, "utf8");
      if (
        parsed.bytesRead !== actualBytes ||
        parsed.bytesRead > input.maxBytes ||
        (!parsed.eof && parsed.bytesRead !== input.maxBytes)
      ) {
        throw invalidRuntimeResponse();
      }
      return parsed;
    },

    async unregister(sourceCapabilityId): Promise<void> {
      const value = await request(kernel, "skill_source.unregister", { sourceCapabilityId });
      parseResponse(unregisterSchema, value);
    }
  };
}

type SkillSourceRuntimeMethod =
  | "skill_source.inspect_root"
  | "skill_source.register"
  | "skill_source.tree"
  | "skill_source.read"
  | "skill_source.unregister";

async function request(
  kernel: Pick<KernelClient, "request">,
  method: SkillSourceRuntimeMethod,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    return await kernel.request<unknown>(method, params);
  } catch (error) {
    throw mapRuntimeError(error);
  }
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidRuntimeResponse();
  }
  return parsed.data;
}

function mapRuntimeError(error: unknown): SkillError {
  if (error instanceof KernelRpcError && isRecord(error.data)) {
    const code = error.data.code;
    if (typeof code === "string" && sourceRuntimeErrorCodes.has(code as SkillErrorCode)) {
      return new SkillError(code as SkillErrorCode, "Skill source runtime request failed");
    }
  }
  return new SkillError("SKILL_SOURCE_UNAVAILABLE", "Skill source runtime request failed");
}

function invalidRuntimeResponse(): SkillError {
  return new SkillError(
    "SKILL_SOURCE_UNAVAILABLE",
    "Skill source runtime returned an invalid response"
  );
}

function isCanonicalRelativePath(value: string): boolean {
  if (value.includes("\0") || isAbsolute(value) || value === ".") {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
