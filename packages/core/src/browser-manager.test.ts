import { describe, expect, it } from "vitest";

import {
  BROWSER_SCREENSHOT_MAX_BYTES,
  MAX_BROWSER_SESSIONS,
  BrowserManager,
  BrowserManagerError,
  type BrowserArtifactMetadata,
  type BrowserDriver,
  type BrowserDriverOpenInput,
  type BrowserDriverSession,
  type BrowserTarget,
  type PreviewBrowserAdapter
} from "./browser-manager.js";
import type { PreviewStatusResult } from "./preview-manager.js";

class FakePreview implements PreviewBrowserAdapter {
  status: PreviewStatusResult = {
    schemaVersion: 1,
    previewId: "pv_test",
    operationId: "op_test",
    url: "http://127.0.0.1:4173/",
    processState: "running",
    reachable: true,
    httpStatus: 200,
    sourceState: {
      headOid: "1".repeat(40),
      changesFingerprint: "a".repeat(64)
    }
  };

  async inspect(): Promise<PreviewStatusResult> {
    return { ...this.status };
  }
}

class FakeDriverSession implements BrowserDriverSession {
  readonly actions: Array<Record<string, unknown>> = [];
  closed = false;
  inspectValue = {
    title: "Fixture",
    url: "http://127.0.0.1:4173/",
    bodyText: "hello",
    ariaSnapshot: "- heading \"Fixture\"",
    viewport: { width: 1280, height: 720 }
  };
  screenshotBytes = Uint8Array.from([137, 80, 78, 71]);
  resizeError: Error | null = null;

  async inspect() {
    return this.inspectValue;
  }

  async click(target: BrowserTarget): Promise<void> {
    this.actions.push({ kind: "click", target });
  }

  async type(target: BrowserTarget, text: string, submit: boolean): Promise<void> {
    this.actions.push({ kind: "type", target, text, submit });
  }

  async setViewport(viewport: { width: number; height: number }): Promise<void> {
    if (this.resizeError) throw this.resizeError;
    this.actions.push({ kind: "setViewport", viewport: { ...viewport } });
    this.inspectValue = { ...this.inspectValue, viewport: { ...viewport } };
  }

  async screenshot(fullPage: boolean): Promise<Uint8Array> {
    this.actions.push({ kind: "screenshot", fullPage });
    return this.screenshotBytes;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeDriver implements BrowserDriver {
  readonly opens: BrowserDriverOpenInput[] = [];
  readonly sessions: FakeDriverSession[] = [];

  async open(input: BrowserDriverOpenInput): Promise<BrowserDriverSession> {
    this.opens.push(input);
    const session = new FakeDriverSession();
    this.sessions.push(session);
    return session;
  }
}

class FakeArtifacts {
  readonly writes: Array<{ mediaType: string; bytes: Uint8Array }> = [];

  async write(mediaType: string, bytes: Uint8Array): Promise<BrowserArtifactMetadata> {
    this.writes.push({ mediaType, bytes });
    return {
      schemaVersion: 1,
      uri: "artifact://ka_browser",
      mediaType,
      sizeBytes: bytes.byteLength,
      sourceTruncated: false
    };
  }
}

function manager() {
  const preview = new FakePreview();
  const driver = new FakeDriver();
  const artifacts = new FakeArtifacts();
  return {
    preview,
    driver,
    artifacts,
    manager: new BrowserManager(preview, driver, artifacts)
  };
}

describe("BrowserManager", () => {
  it("propagates the preview source state through browser evidence without independent source-state scans", async () => {
    const fixture = manager();
    const sourceState = fixture.preview.status.sourceState;

    const opened = await fixture.manager.openPreview({ workspaceId: "ws_test", previewId: "pv_test" });
    const inspected = await fixture.manager.inspect({ workspaceId: "ws_test", previewId: "pv_test" });
    const resized = await fixture.manager.setViewport({
      workspaceId: "ws_test",
      previewId: "pv_test",
      viewport: { width: 390, height: 844 }
    });
    const clicked = await fixture.manager.click({
      workspaceId: "ws_test",
      previewId: "pv_test",
      target: { kind: "role", role: "button", name: "Save" }
    });
    const typed = await fixture.manager.type({
      workspaceId: "ws_test",
      previewId: "pv_test",
      target: { kind: "css", selector: "#email" },
      text: "user@example.test"
    });
    const screenshot = await fixture.manager.screenshot({ workspaceId: "ws_test", previewId: "pv_test" });
    const consoleEvidence = await fixture.manager.console({ workspaceId: "ws_test", previewId: "pv_test" });
    const networkEvidence = await fixture.manager.networkFailures({ workspaceId: "ws_test", previewId: "pv_test" });

    for (const result of [opened, inspected, resized, clicked, typed, screenshot, consoleEvidence, networkEvidence]) {
      expect(result.sourceState).toEqual(sourceState);
    }
  });

  it("binds one idempotent session to the exact live 127.0.0.1 preview origin", async () => {
    const fixture = manager();

    const first = await fixture.manager.openPreview({
      workspaceId: "ws_test",
      previewId: "pv_test",
      viewport: { width: 1024, height: 768 }
    });
    const second = await fixture.manager.openPreview({
      workspaceId: "ws_test",
      previewId: "pv_test",
      viewport: { width: 1024, height: 768 }
    });

    expect(first).toEqual(second);
    expect(first.url).toBe("http://127.0.0.1:4173/");
    expect(fixture.driver.opens).toHaveLength(1);
    expect(fixture.driver.opens[0]?.url).toBe("http://127.0.0.1:4173/");

    fixture.preview.status = { ...fixture.preview.status, reachable: false };
    await expect(
      fixture.manager.inspect({ workspaceId: "ws_test", previewId: "pv_test" })
    ).rejects.toMatchObject({ code: "BROWSER_PREVIEW_NOT_READY" });

    fixture.preview.status = {
      ...fixture.preview.status,
      reachable: true,
      url: "http://localhost:4173/"
    };
    await expect(
      fixture.manager.openPreview({ workspaceId: "ws_other", previewId: "pv_other" })
    ).rejects.toMatchObject({ code: "BROWSER_ORIGIN_INVALID" });
  });

  it("enforces the global session cap without widening preview authority", async () => {
    const fixture = manager();
    for (let index = 0; index < MAX_BROWSER_SESSIONS; index += 1) {
      fixture.preview.status = {
        ...fixture.preview.status,
        previewId: `pv_${index}`,
        operationId: `op_${index}`,
        url: `http://127.0.0.1:${4200 + index}/`
      };
      await fixture.manager.openPreview({ workspaceId: `ws_${index}`, previewId: `pv_${index}` });
    }
    fixture.preview.status = {
      ...fixture.preview.status,
      previewId: "pv_over",
      operationId: "op_over",
      url: "http://127.0.0.1:4999/"
    };
    await expect(
      fixture.manager.openPreview({ workspaceId: "ws_over", previewId: "pv_over" })
    ).rejects.toMatchObject({ code: "BROWSER_LIMIT_REACHED" });
  });

  it("resolves the effective workspace network mode dynamically and fails closed", async () => {
    const fixture = manager();
    let mode: "localhost" | "deny" = "localhost";
    let fail = false;
    const bounded = new BrowserManager(fixture.preview, fixture.driver, fixture.artifacts, {
      networkMode: () => {
        if (fail) throw new Error("policy unavailable");
        return mode;
      }
    });

    await bounded.openPreview({ workspaceId: "ws_test", previewId: "pv_test" });

    const resolver = fixture.driver.opens[0]?.networkMode;
    if (!resolver) throw new Error("network resolver missing");
    expect(await resolver()).toBe("localhost");
    mode = "deny";
    expect(await resolver()).toBe("deny");
    fail = true;
    expect(await resolver()).toBe("deny");
  });

  it("resizes the existing live browser session without opening a second session", async () => {
    const fixture = manager();
    await fixture.manager.openPreview({ workspaceId: "ws_test", previewId: "pv_test" });

    const resized = await fixture.manager.setViewport({
      workspaceId: "ws_test",
      previewId: "pv_test",
      viewport: { width: 390, height: 844 }
    });

    expect(fixture.driver.opens).toHaveLength(1);
    expect(fixture.driver.sessions[0]?.actions).toEqual([
      { kind: "setViewport", viewport: { width: 390, height: 844 } }
    ]);
    expect(resized.viewport).toEqual({ width: 390, height: 844 });
    expect(
      (await fixture.manager.inspect({ workspaceId: "ws_test", previewId: "pv_test" })).viewport
    ).toEqual({ width: 390, height: 844 });
  });

  it("rejects invalid viewport resize and preserves stored viewport after driver failure", async () => {
    const fixture = manager();
    const opened = await fixture.manager.openPreview({
      workspaceId: "ws_test",
      previewId: "pv_test",
      viewport: { width: 1024, height: 768 }
    });

    await expect(
      fixture.manager.setViewport({
        workspaceId: "ws_test",
        previewId: "pv_test",
        viewport: { width: 319, height: 844 }
      })
    ).rejects.toMatchObject({ code: "BROWSER_TARGET_INVALID" });

    fixture.driver.sessions[0]!.resizeError = new Error("resize failed");
    await expect(
      fixture.manager.setViewport({
        workspaceId: "ws_test",
        previewId: "pv_test",
        viewport: { width: 390, height: 844 }
      })
    ).rejects.toMatchObject({ code: "BROWSER_ACTION_FAILED" });

    expect(opened.viewport).toEqual({ width: 1024, height: 768 });
    fixture.driver.sessions[0]!.resizeError = null;
    const afterFailure = await fixture.manager.setViewport({
      workspaceId: "ws_test",
      previewId: "pv_test",
      viewport: { width: 1024, height: 768 }
    });
    expect(afterFailure.viewport).toEqual({ width: 1024, height: 768 });
  });

  it("dispatches only bounded CSS/role click and type targets", async () => {
    const fixture = manager();
    await fixture.manager.openPreview({ workspaceId: "ws_test", previewId: "pv_test" });

    await fixture.manager.click({
      workspaceId: "ws_test",
      previewId: "pv_test",
      target: { kind: "role", role: "button", name: "Save" }
    });
    await fixture.manager.type({
      workspaceId: "ws_test",
      previewId: "pv_test",
      target: { kind: "css", selector: "#email" },
      text: "user@example.test",
      submit: true
    });

    expect(fixture.driver.sessions[0]?.actions).toEqual([
      { kind: "click", target: { kind: "role", role: "button", name: "Save" } },
      {
        kind: "type",
        target: { kind: "css", selector: "#email" },
        text: "user@example.test",
        submit: true
      }
    ]);

    await expect(
      fixture.manager.click({
        workspaceId: "ws_test",
        previewId: "pv_test",
        target: { kind: "css", selector: "x".repeat(2049) }
      })
    ).rejects.toMatchObject({ code: "BROWSER_TARGET_INVALID" });
  });

  it("bounds inspection, console, and failed-request evidence deterministically", async () => {
    const fixture = manager();
    await fixture.manager.openPreview({ workspaceId: "ws_test", previewId: "pv_test" });
    const open = fixture.driver.opens[0];
    if (!open) throw new Error("driver open missing");
    fixture.driver.sessions[0]!.inspectValue = {
      ...fixture.driver.sessions[0]!.inspectValue,
      url: `http://127.0.0.1:4173/${"u".repeat(4000)}`,
      bodyText: "x".repeat(40_000),
      ariaSnapshot: "y".repeat(40_000)
    };
    for (let index = 0; index < 120; index += 1) {
      open.onConsole({ level: "log", text: `message-${index}-${"z".repeat(3000)}` });
      open.onNetworkFailure({
        method: "GET",
        url: `https://example.test/path/${index}?token=secret#frag`,
        resourceType: "fetch",
        failureText: "failed"
      });
    }

    const inspected = await fixture.manager.inspect({
      workspaceId: "ws_test",
      previewId: "pv_test"
    });
    expect(inspected.truncated).toBe(true);
    expect(inspected.truncationReasons).toContain("url");
    expect(Buffer.byteLength(inspected.url)).toBeLessThanOrEqual(2048);
    expect(
      Buffer.byteLength(inspected.title) +
        Buffer.byteLength(inspected.url) +
        Buffer.byteLength(inspected.bodyText) +
        Buffer.byteLength(inspected.ariaSnapshot)
    ).toBeLessThanOrEqual(32 * 1024);

    const consoleEvidence = await fixture.manager.console({
      workspaceId: "ws_test",
      previewId: "pv_test"
    });
    expect(consoleEvidence.entries).toHaveLength(100);
    expect(consoleEvidence.truncated).toBe(true);
    expect(consoleEvidence.entries.at(-1)?.text.length).toBeLessThanOrEqual(2048);

    const failures = await fixture.manager.networkFailures({
      workspaceId: "ws_test",
      previewId: "pv_test"
    });
    expect(failures.entries).toHaveLength(100);
    expect(failures.truncated).toBe(true);
    expect(failures.entries.at(-1)?.url).not.toContain("token=secret");
    expect(failures.entries.at(-1)?.url).not.toContain("#frag");
  });

  it("persists PNG screenshots only through the bounded artifact writer", async () => {
    const fixture = manager();
    await fixture.manager.openPreview({ workspaceId: "ws_test", previewId: "pv_test" });

    const result = await fixture.manager.screenshot({
      workspaceId: "ws_test",
      previewId: "pv_test",
      fullPage: true
    });
    expect(result.artifact.uri).toBe("artifact://ka_browser");
    expect(fixture.artifacts.writes).toEqual([
      { mediaType: "image/png", bytes: Uint8Array.from([137, 80, 78, 71]) }
    ]);

    fixture.driver.sessions[0]!.screenshotBytes = new Uint8Array(BROWSER_SCREENSHOT_MAX_BYTES + 1);
    await expect(
      fixture.manager.screenshot({ workspaceId: "ws_test", previewId: "pv_test" })
    ).rejects.toMatchObject({ code: "BROWSER_SCREENSHOT_TOO_LARGE" });
  });

  it("releases preview/workspace sessions and evicts unexpected disconnects", async () => {
    const fixture = manager();
    await fixture.manager.openPreview({ workspaceId: "ws_test", previewId: "pv_test" });
    await fixture.manager.releasePreview("ws_test", "pv_test");
    expect(fixture.driver.sessions[0]?.closed).toBe(true);
    await expect(
      fixture.manager.inspect({ workspaceId: "ws_test", previewId: "pv_test" })
    ).rejects.toBeInstanceOf(BrowserManagerError);

    await fixture.manager.openPreview({ workspaceId: "ws_test", previewId: "pv_test" });
    fixture.driver.opens[1]?.onDisconnect();
    await expect(
      fixture.manager.inspect({ workspaceId: "ws_test", previewId: "pv_test" })
    ).rejects.toMatchObject({ code: "BROWSER_SESSION_NOT_FOUND" });

    await fixture.manager.openPreview({ workspaceId: "ws_test", previewId: "pv_test" });
    await fixture.manager.releaseWorkspace("ws_test");
    expect(fixture.driver.sessions[2]?.closed).toBe(true);
  });
});
