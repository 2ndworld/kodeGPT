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
        colorScheme: "light"
      });
      context.setDefaultTimeout(BROWSER_ACTION_TIMEOUT_MS);
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

      await page.route("**/*", async (route) => {
        const request = route.request();
        if (
          !isAllowedPreviewRequest(
            input.origin,
            request.url(),
            request.resourceType(),
            input.networkMode
          )
        ) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
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
