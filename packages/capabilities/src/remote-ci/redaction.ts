const REDACTION = "[REDACTED]";

export function redactCiText(text: string, credential: string): string {
  let value = text;
  if (credential.length > 0) {
    value = value.split(credential).join(REDACTION);
  }

  value = value.replace(
    /\bAuthorization\s*:\s*(?:Bearer|token)\s+[^\s\r\n]+/gi,
    `Authorization: ${REDACTION}`
  );
  value = value.replace(
    /\b(?:GH[_]TOKEN|GITHUB[_](?:TOKEN|PAT)|ACTIONS[_](?:RUNTIME[_]TOKEN|ID[_]TOKEN[_]REQUEST[_]TOKEN)|[A-Z0-9_]+(?:SECRET|PASSWORD))\s*=\s*[^\s\r\n]+/g,
    (match) => `${match.slice(0, match.indexOf("=") + 1)}${REDACTION}`
  );
  value = value.replace(
    /https:\/\/[^\s\/@:]+:[^\s\/@]+@[^\s\r\n]+/gi,
    (match) => {
      try {
        const url = new URL(match);
        url.username = "";
        url.password = "";
        return url.toString();
      } catch {
        return REDACTION;
      }
    }
  );
  value = value.replace(/\bg[h][pousr]_[A-Za-z0-9_]{20,}\b/g, REDACTION);
  value = value.replace(/\bgithub[_]pat_[A-Za-z0-9_]{20,}\b/g, REDACTION);
  return value;
}
