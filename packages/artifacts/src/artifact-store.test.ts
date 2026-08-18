import { describe, expect, it } from "vitest";

import {
  ARTIFACT_READ_MAX_BYTES,
  ArtifactStore,
  ArtifactStoreError,
  toPublicArtifactMetadata,
  type ArtifactKernelTransport
} from "./artifact-store.js";

class FakeKernel implements ArtifactKernelTransport {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === "artifact.write") {
      return {
        schemaVersion: 1,
        artifactId: "ka_written123",
        mediaType: params.mediaType,
        bytesWritten: Buffer.from(String(params.dataBase64), "base64").byteLength,
        sourceTruncated: false
      } as T;
    }
    return {
      schemaVersion: 1,
      dataBase64: Buffer.from("hello").toString("base64"),
      bytesRead: 5,
      nextOffset: 5,
      eof: true
    } as T;
  }
}

describe("ArtifactStore", () => {
  it("writes bounded binary bytes through the private kernel artifact authority", async () => {
    const kernel = new FakeKernel();
    const store = new ArtifactStore(kernel);
    const bytes = Buffer.from([0, 1, 2, 255]);

    const result = await store.write("image/png", bytes);

    expect(kernel.calls).toEqual([
      {
        method: "artifact.write",
        params: {
          mediaType: "image/png",
          dataBase64: "AAEC/w=="
        }
      }
    ]);
    expect(result).toEqual({
      schemaVersion: 1,
      uri: "artifact://ka_written123",
      mediaType: "image/png",
      sizeBytes: 4,
      sourceTruncated: false
    });
  });

  it("maps private kernel artifact IDs to versioned artifact:// metadata only", () => {
    expect(
      toPublicArtifactMetadata({
        schemaVersion: 1,
        artifactId: "ka_abc123",
        mediaType: "application/octet-stream",
        bytesWritten: 42,
        sourceTruncated: false
      })
    ).toEqual({
      schemaVersion: 1,
      uri: "artifact://ka_abc123",
      mediaType: "application/octet-stream",
      sizeBytes: 42,
      sourceTruncated: false
    });
  });

  it("performs bounded reads without exposing raw IDs or host paths in the result", async () => {
    const kernel = new FakeKernel();
    const store = new ArtifactStore(kernel);

    const result = await store.read("artifact://ka_abc123", {
      offset: 0,
      maxBytes: ARTIFACT_READ_MAX_BYTES * 4
    });

    expect(kernel.calls).toEqual([
      {
        method: "artifact.read",
        params: {
          artifactId: "ka_abc123",
          offset: 0,
          maxBytes: ARTIFACT_READ_MAX_BYTES
        }
      }
    ]);
    expect(result).toEqual({
      schemaVersion: 1,
      uri: "artifact://ka_abc123",
      dataBase64: Buffer.from("hello").toString("base64"),
      bytesRead: 5,
      nextOffset: 5,
      eof: true
    });
    expect(JSON.stringify(result)).not.toContain("/home/");
  });

  it("rejects raw IDs, traversal-like URIs, and malformed runtime reads", async () => {
    const kernel = new FakeKernel();
    const store = new ArtifactStore(kernel);

    await expect(store.read("ka_abc123")).rejects.toBeInstanceOf(ArtifactStoreError);
    await expect(store.read("artifact://ka_../secret")).rejects.toBeInstanceOf(ArtifactStoreError);

    kernel.request = async () => ({
      schemaVersion: 1,
      path: "/home/user/.kodegpt/artifacts/raw/ka_abc123",
      dataBase64: "",
      bytesRead: 0,
      nextOffset: 0,
      eof: true
    }) as never;
    await expect(store.read("artifact://ka_abc123")).rejects.toBeInstanceOf(ArtifactStoreError);

    kernel.request = async () => ({
      schemaVersion: 1,
      dataBase64: "!!!!",
      bytesRead: 0,
      nextOffset: 0,
      eof: true
    }) as never;
    await expect(store.read("artifact://ka_abc123")).rejects.toBeInstanceOf(ArtifactStoreError);
  });
});
