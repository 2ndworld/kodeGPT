import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";

import { PlaywrightBrowserDriver } from "./playwright-browser-driver.js";

const spike = process.env.KODEGPT_BROWSER_SPIKE === "1" ? it : it.skip;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeServerText(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.byteLength >= 126) throw new Error("spike payload unexpectedly large");
  return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload]);
}

function consumeClientFrames(
  state: { buffer: Buffer },
  chunk: Buffer,
  onText: (text: string) => void
): void {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.byteLength >= 2) {
    const first = state.buffer[0] ?? 0;
    const second = state.buffer[1] ?? 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    const length = second & 0x7f;
    if (!masked || length >= 126) throw new Error("unsupported client WebSocket frame in spike");
    const frameBytes = 2 + 4 + length;
    if (state.buffer.byteLength < frameBytes) return;
    const mask = state.buffer.subarray(2, 6);
    const payload = Buffer.from(state.buffer.subarray(6, frameBytes));
    for (let index = 0; index < payload.byteLength; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    state.buffer = state.buffer.subarray(frameBytes);
    if (opcode === 0x1) onText(payload.toString("utf8"));
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("browser spike condition timed out");
}

spike("launches sandboxed system Chrome and enforces dynamic loopback WebSocket policy", async () => {
  const webSockets = new Set<Socket>();
  const received: string[] = [];
  const webSocketServer = createServer();
  webSocketServer.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        ""
      ].join("\r\n")
    );
    webSockets.add(socket);
    socket.once("close", () => webSockets.delete(socket));
    const state = { buffer: Buffer.alloc(0) };
    socket.on("data", (chunk: Buffer) => {
      consumeClientFrames(state, chunk, (text) => {
        received.push(text);
        socket.write(encodeServerText(`echo:${text}`));
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    webSocketServer.once("error", reject);
    webSocketServer.listen(0, "127.0.0.1", resolve);
  });
  const webSocketAddress = webSocketServer.address();
  if (webSocketAddress === null || typeof webSocketAddress === "string") {
    throw new Error("WebSocket server address missing");
  }

  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><head><title>KodeGPT Browser Spike</title></head>
      <body>
        <label>Email <input id="email" /></label>
        <button id="send" disabled>Send</button>
        <p id="result">pending</p>
        <h1>Ready</h1>
        <script>
          const socket = new WebSocket("ws://127.0.0.1:${webSocketAddress.port}/socket");
          const button = document.querySelector("#send");
          const result = document.querySelector("#result");
          socket.addEventListener("open", () => { button.disabled = false; });
          socket.addEventListener("message", event => { result.textContent = event.data; });
          socket.addEventListener("close", () => { result.textContent = "closed"; });
          button.addEventListener("click", () => socket.send("ping"));
        </script>
      </body></html>`);
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
  let networkMode: "localhost" | "deny" = "localhost";
  let session;
  try {
    session = await driver.open({
      url,
      origin: new URL(url).origin,
      viewport: { width: 800, height: 600 },
      networkMode: () => networkMode,
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

    await session.click({ kind: "css", selector: "#send" });
    await waitFor(() => received.length === 1);
    await waitFor(async () => (await session!.inspect()).bodyText.includes("echo:ping"));
    expect(received).toEqual(["ping"]);

    networkMode = "deny";
    await session.click({ kind: "css", selector: "#send" });
    await waitFor(async () => (await session!.inspect()).bodyText.includes("closed"));
    expect(received).toEqual(["ping"]);

    const screenshot = await session.screenshot(false);
    expect(Array.from(screenshot.slice(0, 4))).toEqual([137, 80, 78, 71]);
    expect(failures).toEqual([]);
    expect(consoleEntries).toEqual([]);
    expect(disconnected).toBe(false);
  } finally {
    await session?.close();
    for (const socket of webSockets) socket.destroy();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);
