import { describe, expect, it } from "vitest";
import {
  countDisplayNameGraphemes,
  DisplayNameError,
  normalizeDisplayNameKey,
  validateDisplayName,
} from "./display-name";

describe("countDisplayNameGraphemes", () => {
  it("counts grapheme clusters, not code units", () => {
    expect(countDisplayNameGraphemes("ab")).toBe(2);
    // 家庭 emoji（多 code point 单 grapheme）。
    expect(countDisplayNameGraphemes("👨‍👩‍👧‍👦")).toBe(1);
    // 旗帜 emoji（两个 regional indicator 组成一个 grapheme）。
    expect(countDisplayNameGraphemes("🇨🇳x")).toBe(2);
  });
});

describe("validateDisplayName", () => {
  it("accepts 2-16 grapheme clusters", () => {
    expect(() => validateDisplayName("ab")).not.toThrow();
    expect(() => validateDisplayName("a".repeat(16))).not.toThrow();
    expect(() => validateDisplayName("🇨🇳".repeat(16))).not.toThrow();
  });

  it("rejects fewer than 2 or more than 16 grapheme clusters", () => {
    expect(() => validateDisplayName("a")).toThrow(DisplayNameError);
    expect(() => validateDisplayName("")).toThrow(DisplayNameError);
    expect(() => validateDisplayName("a".repeat(17))).toThrow(DisplayNameError);
  });

  it("rejects control characters but keeps emoji joiners", () => {
    expect(() => validateDisplayName("a\tb")).toThrow(DisplayNameError);
    expect(() => validateDisplayName("a\nb")).toThrow(DisplayNameError);
    // ZWJ（Cf 类）是合法 emoji 组合字符，不是控制字符；
    // 👨‍👩 是单个 grapheme，附加一个普通字符以满足最小长度。
    expect(() => validateDisplayName("👨‍👩a")).not.toThrow();
  });
});

describe("normalizeDisplayNameKey", () => {
  it("applies NFKC + case folding (docs/03 §5.2)", () => {
    expect(normalizeDisplayNameKey("Ａｂ")).toBe("ab");
    expect(normalizeDisplayNameKey("Café")).toBe(normalizeDisplayNameKey("café"));
  });

  it("distinguishes genuinely different names", () => {
    expect(normalizeDisplayNameKey("alice")).not.toBe(normalizeDisplayNameKey("bob"));
  });
});
