import { timingSafeEqual } from "node:crypto";

import {
  CONNECTOR_ID_BYTES,
  CONNECTOR_SECRET_BYTES,
  CONNECTOR_TOKEN_PREFIX,
  ConnectorCredentialStore,
  deriveConnectorVerifier,
  isCanonicalBase64Url
} from "./credential-store.js";

export interface ParsedConnectorToken {
  id: string;
  secret: string;
}

export function parseConnectorToken(value: string): ParsedConnectorToken | null {
  if (!value.startsWith(CONNECTOR_TOKEN_PREFIX)) {
    return null;
  }
  const separator = value.indexOf(".", CONNECTOR_TOKEN_PREFIX.length);
  if (separator < 0 || value.indexOf(".", separator + 1) >= 0) {
    return null;
  }
  const id = value.slice(CONNECTOR_TOKEN_PREFIX.length, separator);
  const secret = value.slice(separator + 1);
  if (
    !isCanonicalBase64Url(id, CONNECTOR_ID_BYTES) ||
    !isCanonicalBase64Url(secret, CONNECTOR_SECRET_BYTES)
  ) {
    return null;
  }
  return { id, secret };
}

export class ConnectorBearerAuthenticator {
  readonly #store: ConnectorCredentialStore;

  constructor(store: ConnectorCredentialStore) {
    this.#store = store;
  }

  async authenticate(authorization: string | undefined): Promise<boolean> {
    if (authorization === undefined) {
      return false;
    }
    const firstSpace = authorization.indexOf(" ");
    if (firstSpace <= 0 || authorization.indexOf(" ", firstSpace + 1) >= 0) {
      return false;
    }
    const scheme = authorization.slice(0, firstSpace);
    if (scheme.toLowerCase() !== "bearer") {
      return false;
    }
    const parsed = parseConnectorToken(authorization.slice(firstSpace + 1));
    if (parsed === null) {
      return false;
    }
    const record = await this.#store.loadVerifier();
    if (record === undefined || record.id !== parsed.id) {
      return false;
    }
    const actual = Buffer.from(deriveConnectorVerifier(parsed.id, parsed.secret), "base64url");
    const expected = Buffer.from(record.verifier, "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
