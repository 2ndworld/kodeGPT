import { KernelRpcError, type KernelClient } from "@kodegpt/core";
import { describe, expect, it } from "vitest";

import {
  createSkillSourceRuntimeAdapter,
  type PersistedSkillSourceIdentity,
  type SkillSourceRuntimeAdapter
} from "./index.js";

type RuntimeCall = { method: string; params: Record<string, unknown> };

function fakeKernel(
  responder: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
): { kernel: Pick<KernelClient, "request">; calls: RuntimeCall[] } {
  const calls: RuntimeCall[] = [];
  const kernel: Pick<KernelClient, "request"> = {
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      return (await responder(method, params)) as T;
    }
  };
  return { kernel, calls };
}

const identity: PersistedSkillSourceIdentity = {
  deviceMajor: 8,
  deviceMinor: 1,
  inode: "12345"
};

describe("createSkillSourceRuntimeAdapter", () => {
  it("uses only the five fixed skill_source RPC methods with exact params", async () => {
    const { kernel, calls } = fakeKernel((method, params) => {
      switch (method) {
        case "skill_source.inspect_root":
          return { canonicalRoot: "/canonical/skills", identity };
        case "skill_source.register":
          return { sourceCapabilityId: "sc_123_1" };
        case "skill_source.tree":
          return {
            entries: [
              { path: "alpha", kind: "directory", sizeBytes: 4096 },
              { path: "alpha/SKILL.md", kind: "file", sizeBytes: 19 }
            ],
            truncated: false
          };
        case "skill_source.read":
          return params.encoding === "base64"
            ? { contentBase64: "AP8BgA==", bytesRead: 4, eof: true }
            : { contents: "hello", bytesRead: 5, eof: true };
        case "skill_source.unregister":
          return { ok: true };
        default:
          throw new Error(`unexpected method ${method}`);
      }
    });
    const adapter: SkillSourceRuntimeAdapter = createSkillSourceRuntimeAdapter(kernel);

    expect(await adapter.inspectRoot("/input/skills")).toEqual({
      canonicalRoot: "/canonical/skills",
      identity
    });
    expect(
      await adapter.register({ rootPath: "/canonical/skills", expectedIdentity: identity })
    ).toEqual({ sourceCapabilityId: "sc_123_1" });
    expect(
      await adapter.tree({ sourceCapabilityId: "sc_123_1", path: ".", maxEntries: 20_000 })
    ).toEqual({
      entries: [
        { path: "alpha", kind: "directory", sizeBytes: 4096 },
        { path: "alpha/SKILL.md", kind: "file", sizeBytes: 19 }
      ],
      truncated: false
    });
    expect(
      await adapter.read({
        sourceCapabilityId: "sc_123_1",
        path: "alpha/SKILL.md",
        offset: 0,
        maxBytes: 256
      })
    ).toEqual({ contents: "hello", bytesRead: 5, eof: true });
    const binary = await adapter.readBytes({
      sourceCapabilityId: "sc_123_1",
      path: "assets/binary.bin",
      offset: 0,
      maxBytes: 256
    });
    expect([...binary.bytes]).toEqual([0, 255, 1, 128]);
    expect({ bytesRead: binary.bytesRead, eof: binary.eof }).toEqual({ bytesRead: 4, eof: true });
    await expect(adapter.unregister("sc_123_1")).resolves.toBeUndefined();

    expect(calls).toEqual([
      { method: "skill_source.inspect_root", params: { path: "/input/skills" } },
      {
        method: "skill_source.register",
        params: { rootPath: "/canonical/skills", expectedIdentity: identity }
      },
      {
        method: "skill_source.tree",
        params: { sourceCapabilityId: "sc_123_1", path: ".", maxEntries: 20_000 }
      },
      {
        method: "skill_source.read",
        params: {
          sourceCapabilityId: "sc_123_1",
          path: "alpha/SKILL.md",
          offset: 0,
          maxBytes: 256
        }
      },
      {
        method: "skill_source.read",
        params: {
          sourceCapabilityId: "sc_123_1",
          path: "assets/binary.bin",
          offset: 0,
          maxBytes: 256,
          encoding: "base64"
        }
      },
      { method: "skill_source.unregister", params: { sourceCapabilityId: "sc_123_1" } }
    ]);
  });

  it("fails closed on malformed or host-path-bearing runtime responses", async () => {
    const cases: Array<{
      response: unknown;
      invoke: (adapter: SkillSourceRuntimeAdapter) => Promise<unknown>;
    }> = [
      {
        response: { canonicalRoot: "/skills", identity, hostPath: "/home/private" },
        invoke: (adapter) => adapter.inspectRoot("/skills")
      },
      {
        response: { sourceCapabilityId: "not-a-capability" },
        invoke: (adapter) => adapter.register({ rootPath: "/skills", expectedIdentity: identity })
      },
      {
        response: {
          entries: [{ path: "SKILL.md", kind: "socket", sizeBytes: 1 }],
          truncated: false
        },
        invoke: (adapter) =>
          adapter.tree({ sourceCapabilityId: "sc_1_1", path: ".", maxEntries: 20_000 })
      },
      {
        response: {
          entries: [{ path: "SKILL.md", kind: "file", sizeBytes: -1 }],
          truncated: false
        },
        invoke: (adapter) =>
          adapter.tree({ sourceCapabilityId: "sc_1_1", path: ".", maxEntries: 20_000 })
      },
      {
        response: { contents: "hello", bytesRead: 4, eof: true },
        invoke: (adapter) =>
          adapter.read({
            sourceCapabilityId: "sc_1_1",
            path: "SKILL.md",
            offset: 0,
            maxBytes: 256
          })
      },
      {
        response: { contents: "abc", bytesRead: 3, eof: false },
        invoke: (adapter) =>
          adapter.read({
            sourceCapabilityId: "sc_1_1",
            path: "SKILL.md",
            offset: 0,
            maxBytes: 256
          })
      },
      {
        response: { contentBase64: "%%%", bytesRead: 2, eof: true },
        invoke: (adapter) =>
          adapter.readBytes({
            sourceCapabilityId: "sc_1_1",
            path: "assets/binary.bin",
            offset: 0,
            maxBytes: 256
          })
      },
      {
        response: { ok: true, hostPath: "/home/private" },
        invoke: (adapter) => adapter.unregister("sc_1_1")
      }
    ];

    for (const testCase of cases) {
      const { kernel } = fakeKernel(() => testCase.response);
      await expect(testCase.invoke(createSkillSourceRuntimeAdapter(kernel))).rejects.toMatchObject({
        code: "SKILL_SOURCE_UNAVAILABLE",
        message: "Skill source runtime returned an invalid response"
      });
    }
  });

  it("maps only stable machine error data and never forwards raw runtime messages", async () => {
    for (const code of [
      "SKILL_SOURCE_INVALID",
      "SKILL_SOURCE_STATE_OVERLAP",
      "SKILL_SOURCE_IDENTITY_CHANGED",
      "SKILL_SOURCE_UNAVAILABLE",
      "SKILL_SOURCE_BOUNDARY_VIOLATION",
      "SKILL_SOURCE_LIMIT_EXCEEDED",
      "SKILL_RESOURCE_UNSUPPORTED"
    ] as const) {
      const { kernel } = fakeKernel(() => {
        throw new KernelRpcError(-32100, "raw host failure /home/private/skills", { code });
      });

      await expect(createSkillSourceRuntimeAdapter(kernel).inspectRoot("/skills")).rejects.toMatchObject({
        code,
        message: "Skill source runtime request failed"
      });
      try {
        await createSkillSourceRuntimeAdapter(kernel).inspectRoot("/skills");
      } catch (error) {
        expect(String(error)).not.toContain("/home/private");
      }
    }

    const { kernel } = fakeKernel(() => {
      throw new KernelRpcError(-39999, "raw /home/private", { code: "UNKNOWN_CODE" });
    });
    await expect(createSkillSourceRuntimeAdapter(kernel).inspectRoot("/skills")).rejects.toMatchObject({
      code: "SKILL_SOURCE_UNAVAILABLE",
      message: "Skill source runtime request failed"
    });
  });
});
