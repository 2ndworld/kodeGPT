import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page
} from "playwright-core";

import type {
  BrowserDriver,
  BrowserDriverInspectResult,
  BrowserDriverOpenInput,
  BrowserDriverSession,
  BrowserNetworkMode,
  BrowserTarget
} from "./browser-manager.js";

const BROWSER_ACTION_TIMEOUT_MS = 5_000;
export const BROWSER_FULL_PAGE_MAX_PIXELS = 3840 * 2160;

export function isAllowedPreviewDocumentUrl(origin: string, urlText: string): boolean {
  try {
    const url = new URL(urlText);
    return url.origin === origin;
  } catch {
    return false;
  }
}

export function isAllowedPreviewRequest(
  origin: string,
  urlText: string,
  resourceType: string,
  networkMode: BrowserNetworkMode
): boolean {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return false;
  }
  if (url.origin === origin) return true;
  if (resourceType === "document") return false;
  if (networkMode === "unrestricted") return true;
  if (networkMode !== "localhost") return false;
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
  );
}

export function isAllowedPreviewWebSocket(
  origin: string,
  urlText: string,
  networkMode: BrowserNetworkMode
): boolean {
  let preview: URL;
  let url: URL;
  try {
    preview = new URL(origin);
    url = new URL(urlText);
  } catch {
    return false;
  }
  const expectedProtocol = preview.protocol === "https:" ? "wss:" : "ws:";
  if (
    url.protocol === expectedProtocol &&
    url.hostname === preview.hostname &&
    url.port === preview.port
  ) {
    return true;
  }
  if (networkMode === "unrestricted") return url.protocol === "ws:" || url.protocol === "wss:";
  if (networkMode !== "localhost") return false;
  return (
    (url.protocol === "ws:" || url.protocol === "wss:") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
  );
}

export function isScreenshotGeometryAllowed(width: number, height: number): boolean {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width * height <= BROWSER_FULL_PAGE_MAX_PIXELS
  );
}

async function currentNetworkMode(input: BrowserDriverOpenInput): Promise<BrowserNetworkMode | null> {
  try {
    return await input.networkMode();
  } catch {
    return null;
  }
}

async function websocketAllowed(input: BrowserDriverOpenInput, url: string): Promise<boolean> {
  const networkMode = await currentNetworkMode(input);
  return networkMode !== null && isAllowedPreviewWebSocket(input.origin, url, networkMode);
}

function locatorFor(page: Page, target: BrowserTarget): Locator {
  if (target.kind === "css") {
    return page.locator(target.selector).first();
  }
  return page
    .getByRole(target.role as Parameters<Page["getByRole"]>[0], {
      ...(target.name === undefined ? {} : { name: target.name })
    })
    .first();
}

class PlaywrightBrowserSession implements BrowserDriverSession {
  readonly #browser: Browser;
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #viewport: { width: number; height: number };
  #closed = false;

  constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    viewport: { width: number; height: number }
  ) {
    this.#browser = browser;
    this.#context = context;
    this.#page = page;
    this.#viewport = viewport;
  }

  async inspect(): Promise<BrowserDriverInspectResult> {
    const body = this.#page.locator("body");
    const [title, bodyText, ariaSnapshot] = await Promise.all([
      this.#page.title(),
      body.innerText({ timeout: BROWSER_ACTION_TIMEOUT_MS }).catch(() => ""),
      body.ariaSnapshot({ timeout: BROWSER_ACTION_TIMEOUT_MS }).catch(() => "")
    ]);
    return {
      title,
      url: this.#page.url(),
      bodyText,
      ariaSnapshot,
      viewport: this.#page.viewportSize() ?? { ...this.#viewport }
    };
  }

  async click(target: BrowserTarget): Promise<void> {
    await locatorFor(this.#page, target).click({ timeout: BROWSER_ACTION_TIMEOUT_MS });
  }

  async type(target: BrowserTarget, text: string, submit: boolean): Promise<void> {
    const locator = locatorFor(this.#page, target);
    await locator.fill(text, { timeout: BROWSER_ACTION_TIMEOUT_MS });
    if (submit) {
      await locator.press("Enter", { timeout: BROWSER_ACTION_TIMEOUT_MS });
    }
  }

  async screenshot(fullPage: boolean): Promise<Uint8Array> {
    if (fullPage) {
      const [htmlBox, bodyBox] = await Promise.all([
        this.#page.locator("html").boundingBox(),
        this.#page.locator("body").boundingBox()
      ]);
      const boxes = [htmlBox, bodyBox].filter(
        (box): box is NonNullable<typeof box> => box !== null
      );
      if (boxes.length === 0) {
        throw new Error("browser full-page screenshot geometry is unavailable");
      }
      const width = Math.max(...boxes.map((box) => box.width));
      const height = Math.max(...boxes.map((box) => box.height));
      if (!isScreenshotGeometryAllowed(width, height)) {
        throw new Error("browser full-page screenshot geometry exceeds bounded limit");
      }
    }
    return this.#page.screenshot({
      type: "png",
      fullPage,
      animations: "disabled",
      timeout: BROWSER_ACTION_TIMEOUT_MS
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#context.close().catch(() => undefined);
    await this.#browser.close().catch(() => undefined);
  }
}

export class PlaywrightBrowserDriver implements BrowserDriver {
  async open(input: BrowserDriverOpenInput): Promise<BrowserDriverSession> {
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      chromiumSandbox: true
    });
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        viewport: { ...input.viewport },
        locale: "en-US",
        colorScheme: "light",
        serviceWorkers: "block"
      });
      context.setDefaultTimeout(BROWSER_ACTION_TIMEOUT_MS);

      await context.route("**/*", async (route) => {
        const request = route.request();
        const networkMode = await currentNetworkMode(input);
        if (
          networkMode === null ||
          !isAllowedPreviewRequest(
            input.origin,
            request.url(),
            request.resourceType(),
            networkMode
          )
        ) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });

      await context.routeWebSocket("**/*", async (webSocket) => {
        const url = webSocket.url();
        if (!(await websocketAllowed(input, url))) {
          await webSocket.close({ code: 1008, reason: "KodeGPT network policy denied" });
          return;
        }

        const server = webSocket.connectToServer();
        const closeDenied = async (): Promise<void> => {
          await Promise.allSettled([
            webSocket.close({ code: 1008, reason: "KodeGPT network policy denied" }),
            server.close({ code: 1008, reason: "KodeGPT network policy denied" })
          ]);
        };

        webSocket.onMessage(async (message) => {
          if (!(await websocketAllowed(input, url))) {
            await closeDenied();
            return;
          }
          server.send(message);
        });
        server.onMessage(async (message) => {
          if (!(await websocketAllowed(input, url))) {
            await closeDenied();
            return;
          }
          webSocket.send(message);
        });
      });

      const page = await context.newPage();

      page.on("console", (message) => {
        input.onConsole({ level: message.type(), text: message.text() });
      });
      page.on("requestfailed", (request) => {
        input.onNetworkFailure({
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
          failureText: request.failure()?.errorText ?? "request failed"
        });
      });
      page.on("download", (download) => {
        void download.cancel().catch(() => undefined);
      });
      browser.on("disconnected", input.onDisconnect);

      context.on("page", (openedPage) => {
        if (openedPage !== page) {
          void openedPage.close().catch(() => undefined);
        }
      });

      await page.goto(input.url, {
        waitUntil: "domcontentloaded",
        timeout: BROWSER_ACTION_TIMEOUT_MS
      });
      if (!isAllowedPreviewDocumentUrl(input.origin, page.url())) {
        throw new Error("preview document escaped its exact origin");
      }
      return new PlaywrightBrowserSession(browser, context, page, input.viewport);
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }
}
