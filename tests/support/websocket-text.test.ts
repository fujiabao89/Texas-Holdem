import { describe, expect, it } from "vitest";
import { observedWebSocketText } from "./websocket-text";

describe("native WebSocket observation preserves Unicode", () => {
  it("decodes Firefox UTF-8 frame bytes without corrupting public player names", () => {
    const text = JSON.stringify({ displayName: "时序玩家 🍀 α", amount: 120 });
    expect(observedWebSocketText(Buffer.from(text).toString("latin1"), "firefox")).toBe(text);
  });
  it("preserves native Chromium/WebKit text and UTF-8 buffers", () => {
    const text = "时序玩家 🍀";
    expect(observedWebSocketText(text, "chromium")).toBe(text);
    expect(observedWebSocketText(text, "webkit")).toBe(text);
    expect(observedWebSocketText(Buffer.from(text), "firefox")).toBe(text);
  });
  it("keeps ASCII JSON valid and rejects broken UTF-8 rather than replacing bytes", () => {
    expect(observedWebSocketText('{"sequence":"42"}', "firefox")).toBe('{"sequence":"42"}');
    expect(() => observedWebSocketText("\xff", "firefox")).toThrow();
    expect(() => observedWebSocketText("中文", "firefox")).toThrow(
      "unexpected Firefox frame encoding",
    );
  });
});
