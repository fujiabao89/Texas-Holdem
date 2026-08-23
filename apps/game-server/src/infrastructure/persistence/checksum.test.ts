import { describe, expect, it } from "vitest";
import { sha256Checksum, stableStringify } from "./checksum";

describe("stableStringify", () => {
  it("sorts object keys recursively and omits insignificant whitespace", () => {
    expect(stableStringify({ b: 1, a: { d: [3, 2], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,2]},"b":1}',
    );
  });

  it("is order-independent for logically equal objects", () => {
    expect(stableStringify({ x: 1, y: { z: 2 } })).toBe(stableStringify({ y: { z: 2 }, x: 1 }));
  });

  it("serializes bigint as decimal (sequence/chips, docs/03 §5.9)", () => {
    expect(stableStringify({ sequence: 9007199254740993n })).toBe('{"sequence":9007199254740993}');
  });

  it("serializes Date as ISO-8601 UTC string, not {}", () => {
    // Date 无可枚举自有属性：不特判会落入对象分支输出 `{}`，
    // 使仅时间戳不同的 Bundle 得到相同 commit_checksum。
    expect(stableStringify(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(stableStringify({ startedAt: new Date(86400000) })).toBe(
      '{"startedAt":"1970-01-02T00:00:00.000Z"}',
    );
    // 嵌套数组中的 Date 同样生效。
    expect(stableStringify([new Date(0), new Date(1)])).toBe(
      '["1970-01-01T00:00:00.000Z","1970-01-01T00:00:00.001Z"]',
    );
  });

  it("rejects invalid dates instead of serializing them as {}", () => {
    expect(() => stableStringify({ at: new Date(Number.NaN) })).toThrow();
  });

  it("keeps array order significant", () => {
    expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]));
  });

  it("drops undefined-valued keys like JSON.stringify", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => stableStringify({ a: Number.NaN })).toThrow(TypeError);
  });
});

describe("sha256Checksum", () => {
  it("returns a 32-byte digest of the canonical form", () => {
    const checksum = sha256Checksum({ b: 2, a: 1 });
    expect(checksum).toBeInstanceOf(Buffer);
    expect(checksum.length).toBe(32);
  });

  it("is equal for logically equal but differently-ordered input", () => {
    expect(sha256Checksum({ a: 1, b: [2, 3] }).equals(sha256Checksum({ b: [2, 3], a: 1 }))).toBe(
      true,
    );
  });

  it("differs when content differs", () => {
    expect(sha256Checksum({ a: 1 }).equals(sha256Checksum({ a: 2 }))).toBe(false);
  });

  it("distinguishes bundles differing only in Date fields", () => {
    expect(sha256Checksum({ at: new Date(0) }).equals(sha256Checksum({ at: new Date(1) }))).toBe(
      false,
    );
    // 同一时刻的 Date 产生相同摘要（canonical 形式可重现）。
    expect(sha256Checksum({ at: new Date(0) }).equals(sha256Checksum({ at: new Date(0) }))).toBe(
      true,
    );
  });
});
