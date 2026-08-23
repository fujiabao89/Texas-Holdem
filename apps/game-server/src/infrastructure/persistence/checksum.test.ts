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
});
