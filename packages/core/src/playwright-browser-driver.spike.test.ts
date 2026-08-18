import { createServer } from "node:http";

import { expect, it } from "vitest";

import { PlaywrightBrowserDriver } from "./playwright-browser-driver.js";

const spike = process.env.KODEGPT_BROWSER_SPIKE === "1" ? it : it.skip;

spike("launches sandboxed system Chrome and loads a loopback preview", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><head><title>KodeGPT Browser Spike</title></head>
      <body><label>Email <input id="email" /></label><button>Save</button><h1>Ready</h1></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback server address missing");
  const url = `http://127.0.0.1:${address.port}/`;
  const driver = new PlaywrightBrowserDriver();
  const consoleEntries: string[] = [];
  const failures: string[] = [];
  let disconnected = false;
  let session;
  try {
    session = await driver.open({
      url,
      origin: new URL(url).origin,
      viewport: { width: 800, height: 600 },
      networkMode: "deny",
      onConsole: (entry) => consoleEntries.push(entry.text),
      onNetworkFailure: (entry) => failures.push(entry.url),
      onDisconnect: () => {
        disconnected = true;
      }
    });
    const inspected = await session.inspect();
    expect(inspected.title).toBe("KodeGPT Browser Spike");
    expect(inspected.bodyText).toContain("Ready");
    expect(inspected.ariaSnapshot).toContain("heading \"Ready\"");
    await session.type({ kind: "css", selector: "#email" }, "user@example.test", false);
    const screenshot = await session.screenshot(false);
    expect(Array.from(screenshot.slice(0, 4))).toEqual([137, 80, 78, 71]);
    expect(failures).toEqual([]);
    expect(consoleEntries).toEqual([]);
    expect(disconnected).toBe(false);
  } finally {
    await session?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);
