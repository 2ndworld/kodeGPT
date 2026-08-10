import { DEV_CONSOLE_HTML } from "./generated-html.js";

export const DEV_CONSOLE_RESOURCE_URI = "ui://kodegpt/dev-console/v1" as const;
export const DEV_CONSOLE_CURRENT_RESOURCE_URI = "ui://kodegpt/dev-console/current" as const;
export const DEV_CONSOLE_MIME_TYPE = "text/html;profile=mcp-app" as const;

export const DEV_CONSOLE_RESOURCE_META = Object.freeze({
  ui: {
    csp: {
      connectDomains: [] as string[],
      resourceDomains: [] as string[],
      frameDomains: [] as string[]
    }
  }
});

export interface DevConsoleResourceContent {
  uri: string;
  mimeType: typeof DEV_CONSOLE_MIME_TYPE;
  text: string;
  _meta: typeof DEV_CONSOLE_RESOURCE_META;
}

export function devConsoleResourceContent(
  uri: typeof DEV_CONSOLE_RESOURCE_URI | typeof DEV_CONSOLE_CURRENT_RESOURCE_URI = DEV_CONSOLE_RESOURCE_URI
): DevConsoleResourceContent {
  if (uri !== DEV_CONSOLE_RESOURCE_URI && uri !== DEV_CONSOLE_CURRENT_RESOURCE_URI) {
    throw new TypeError("unsupported dev console resource URI");
  }
  return {
    uri,
    mimeType: DEV_CONSOLE_MIME_TYPE,
    text: DEV_CONSOLE_HTML,
    _meta: DEV_CONSOLE_RESOURCE_META
  };
}
