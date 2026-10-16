/** Playwright 1.62 Firefox Juggler exposes text frame bytes as Latin-1 code units. */
export function observedWebSocketText(payload: string | Buffer, browserName: string): string {
  if (Buffer.isBuffer(payload)) return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  if (browserName !== "firefox") return payload;
  if ([...payload].some((character) => character.charCodeAt(0) > 255))
    throw new Error("unexpected Firefox frame encoding");
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload, "latin1"));
}
