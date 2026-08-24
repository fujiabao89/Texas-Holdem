import { describe, expect, it } from "vitest";
import { extractBearerToken } from "./auth";

describe("extractBearerToken", () => {
  it("提取标准 Bearer token", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("大小写不敏感（bearer），并容忍首尾空白", () => {
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
    expect(extractBearerToken("  Bearer  abc123  ")).toBe("abc123");
  });

  it("非 Bearer 方案或缺失返回 undefined", () => {
    expect(extractBearerToken("Basic abc")).toBeUndefined();
    expect(extractBearerToken("abc123")).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it("无 token 或空 token 返回 undefined", () => {
    expect(extractBearerToken("Bearer")).toBeUndefined();
    expect(extractBearerToken("Bearer   ")).toBeUndefined();
  });

  it("超长空白串不会导致正则灾难性回溯（线性时间内返回）", () => {
    const manySpaces = `bearer${" ".repeat(200_000)}`;
    expect(extractBearerToken(manySpaces)).toBeUndefined();
  });
});
