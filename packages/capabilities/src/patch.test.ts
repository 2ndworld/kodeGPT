import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MAX_PATCH_BYTES, MAX_PATCH_FILES, MAX_PATCH_HUNKS } from "./contracts.js";
import { CapabilityError } from "./errors.js";
import { patchFile } from "./patch.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fakeAdapters(initial: Record<string, string>, options: { failPath?: string } = {}) {
  const files = new Map(Object.entries(initial));
  const commits: Array<Record<string, unknown>> = [];
  const workspace = {
    async pathIdentity(_workspaceId: string, path: string) {
      const contents = files.get(path);
      return contents === undefined
        ? { exists: false, hashTruncated: false }
        : {
            exists: true,
            kind: "file" as const,
            sizeBytes: Buffer.byteLength(contents),
            hashTruncated: false
          };
    },
    async readFile(_workspaceId: string, path: string, readOptions?: { maxBytes?: number }) {
      const contents = files.get(path);
      if (contents === undefined) throw new Error("FILE_NOT_FOUND");
      const maxBytes = readOptions?.maxBytes ?? MAX_PATCH_BYTES;
      if (Buffer.byteLength(contents) > maxBytes) {
        return { contents: contents.slice(0, maxBytes), bytesRead: maxBytes, eof: false };
      }
      return { contents, bytesRead: Buffer.byteLength(contents), eof: true };
    }
  };
  const commit = {
    async commitPatchFile(input: {
      workspaceId: string;
      path: string;
      action: "create" | "update" | "delete";
      expectedSha256: string | null;
      content: string | null;
    }) {
      commits.push({ ...input });
      if (options.failPath === input.path) throw new Error("host commit failure");
      if (input.action === "delete") {
        files.delete(input.path);
        return { schemaVersion: 1 as const, action: input.action, bytesWritten: 0, sha256: null };
      }
      files.set(input.path, input.content!);
      return {
        schemaVersion: 1 as const,
        action: input.action,
        bytesWritten: Buffer.byteLength(input.content!),
        sha256: sha256(input.content!)
      };
    }
  };
  return { workspace, commit, commits, files };
}

const MODIFY_PATCH = `--- a/src/example.txt
+++ b/src/example.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+bravo
 gamma
@@ -5,2 +5,2 @@
 epsilon
-zeta
+zed
`;

describe("file.patch", () => {
  it("defaults to check, applies multiple hunks in memory, and never commits in check mode", async () => {
    const adapters = fakeAdapters({
      "src/example.txt": "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n"
    });

    const result = await patchFile(adapters.workspace, adapters.commit, {
      workspaceId: "ws_1",
      patch: MODIFY_PATCH
    });

    expect(result.mode).toBe("check");
    expect(result.committedPaths).toEqual([]);
    expect(adapters.commits).toEqual([]);
    expect(result.files).toEqual([
      {
        path: "src/example.txt",
        action: "update",
        expectedSha256: sha256("alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n"),
        resultingSha256: sha256("alpha\nbravo\ngamma\ndelta\nepsilon\nzed\n"),
        bytes: Buffer.byteLength("alpha\nbravo\ngamma\ndelta\nepsilon\nzed\n"),
        committed: false
      }
    ]);
  });

  it("preflights create/update/delete and commits in lexical path order only after all files pass", async () => {
    const adapters = fakeAdapters({
      "z-delete.txt": "remove\n",
      "m-update.txt": "old\n"
    });
    const patch = `--- a/z-delete.txt
+++ /dev/null
@@ -1 +0,0 @@
-remove
--- /dev/null
+++ b/a-create.txt
@@ -0,0 +1 @@
+created
--- a/m-update.txt
+++ b/m-update.txt
@@ -1 +1 @@
-old
+new
`;

    const result = await patchFile(adapters.workspace, adapters.commit, {
      workspaceId: "ws_1",
      patch,
      mode: "apply"
    });

    expect(adapters.commits.map((value) => value.path)).toEqual([
      "a-create.txt",
      "m-update.txt",
      "z-delete.txt"
    ]);
    expect(result.committedPaths).toEqual(["a-create.txt", "m-update.txt", "z-delete.txt"]);
    expect(result.files.every((file) => file.committed)).toBe(true);
    expect(adapters.files.get("a-create.txt")).toBe("created\n");
    expect(adapters.files.get("m-update.txt")).toBe("new\n");
    expect(adapters.files.has("z-delete.txt")).toBe(false);
  });

  it("performs full preflight before the first commit, including create existence and bounded complete reads", async () => {
    const existingCreate = fakeAdapters({ "a.txt": "already\n", "z.txt": "old\n" });
    const patch = `--- a/z.txt
+++ b/z.txt
@@ -1 +1 @@
-old
+new
--- /dev/null
+++ b/a.txt
@@ -0,0 +1 @@
+created
`;
    await expect(
      patchFile(existingCreate.workspace, existingCreate.commit, {
        workspaceId: "ws_1",
        patch,
        mode: "apply"
      })
    ).rejects.toMatchObject({ code: "PATCH_PRECONDITION_FAILED" });
    expect(existingCreate.commits).toEqual([]);
    expect(existingCreate.files.get("z.txt")).toBe("old\n");

    const oversized = fakeAdapters({ "large.txt": "x".repeat(MAX_PATCH_BYTES + 1) });
    await expect(
      patchFile(oversized.workspace, oversized.commit, {
        workspaceId: "ws_1",
        patch: `--- a/large.txt\n+++ b/large.txt\n@@ -1 +1 @@\n-${"x".repeat(8)}\n+small\n`,
        mode: "apply"
      })
    ).rejects.toMatchObject({ code: "PATCH_PRECONDITION_FAILED" });
    expect(oversized.commits).toEqual([]);
  });

  it("reports partial apply state explicitly and never claims rollback", async () => {
    const adapters = fakeAdapters({ "a.txt": "old-a\n", "b.txt": "old-b\n" }, { failPath: "b.txt" });
    const patch = `--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old-a
+new-a
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-old-b
+new-b
`;

    await expect(
      patchFile(adapters.workspace, adapters.commit, { workspaceId: "ws_1", patch, mode: "apply" })
    ).rejects.toMatchObject({
      code: "PATCH_COMMIT_INCOMPLETE",
      details: { committedPaths: ["a.txt"], failedPath: "b.txt" }
    });
    expect(adapters.files.get("a.txt")).toBe("new-a\n");
    expect(adapters.files.get("b.txt")).toBe("old-b\n");
  });

  it.each([
    ["absolute", `--- a/good.txt\n+++ /etc/passwd\n@@ -1 +1 @@\n-old\n+new\n`],
    ["traversal", `--- a/../escape.txt\n+++ b/../escape.txt\n@@ -1 +1 @@\n-old\n+new\n`],
    ["binary", `GIT binary patch\nliteral 1\nA\n`],
    ["rename", `rename from old.txt\nrename to new.txt\n`],
    ["copy", `copy from old.txt\ncopy to new.txt\n`],
    ["malformed range", `--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,1 @@\n-old\n+new\n`],
    ["duplicate path", `--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-new\n+newer\n`]
  ])("rejects unsupported or ambiguous %s patches", async (_label, patch) => {
    const adapters = fakeAdapters({ "a.txt": "old\n", "good.txt": "old\n" });
    await expect(patchFile(adapters.workspace, adapters.commit, { workspaceId: "ws_1", patch }))
      .rejects.toBeInstanceOf(CapabilityError);
    expect(adapters.commits).toEqual([]);
  });

  it("rejects hunk text mismatches as precondition failure with zero commits", async () => {
    const adapters = fakeAdapters({ "a.txt": "actual\n" });
    await expect(
      patchFile(adapters.workspace, adapters.commit, {
        workspaceId: "ws_1",
        patch: `--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-expected\n+new\n`,
        mode: "apply"
      })
    ).rejects.toMatchObject({
      code: "PATCH_PRECONDITION_FAILED",
      details: {
        reason: "STALE_EXPECTED_STATE",
        retryable: false,
        suggestedAction: "refresh-state"
      }
    });
    expect(adapters.commits).toEqual([]);
  });

  it("rejects invalid runtime modes even when callers bypass TypeScript typing", async () => {
    const adapters = fakeAdapters({ "a.txt": "old\n" });
    await expect(
      patchFile(adapters.workspace, adapters.commit, {
        workspaceId: "ws_1",
        patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
        mode: "unsafe" as "check"
      })
    ).rejects.toMatchObject({ code: "CAPABILITY_INPUT_INVALID" });
    expect(adapters.commits).toEqual([]);
  });

  it("enforces patch byte, file, and hunk ceilings", async () => {
    const adapters = fakeAdapters({});
    await expect(
      patchFile(adapters.workspace, adapters.commit, {
        workspaceId: "ws_1",
        patch: "x".repeat(MAX_PATCH_BYTES + 1)
      })
    ).rejects.toMatchObject({ code: "CAPABILITY_LIMIT_EXCEEDED" });

    const tooManyFiles = Array.from({ length: MAX_PATCH_FILES + 1 }, (_, index) =>
      `--- /dev/null\n+++ b/f${index}.txt\n@@ -0,0 +1 @@\n+x\n`
    ).join("");
    await expect(
      patchFile(adapters.workspace, adapters.commit, { workspaceId: "ws_1", patch: tooManyFiles })
    ).rejects.toMatchObject({ code: "CAPABILITY_LIMIT_EXCEEDED" });

    const hunks = Array.from({ length: MAX_PATCH_HUNKS + 1 }, () => "@@ -0,0 +1 @@\n+x\n").join("");
    await expect(
      patchFile(adapters.workspace, adapters.commit, {
        workspaceId: "ws_1",
        patch: `--- /dev/null\n+++ b/many.txt\n${hunks}`
      })
    ).rejects.toMatchObject({ code: "CAPABILITY_LIMIT_EXCEEDED" });
  });
});
