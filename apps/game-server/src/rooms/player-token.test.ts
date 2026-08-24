import { describe, expect, it } from "vitest";
import { PLAYER_TOKEN_BYTES, generatePlayerToken } from "./player-token";

function zeros(count: number): Uint8Array {
  return new Uint8Array(count);
}

describe("generatePlayerToken", () => {
  it("由恰好 256 bit（32 字节）随机熵生成，base64url 编码不小于 43 字符", () => {
    const token = generatePlayerToken(() => zeros(PLAYER_TOKEN_BYTES));
    expect(token).toHaveLength(43);
    expect(token).toBe("A".repeat(43));
    expect(PLAYER_TOKEN_BYTES).toBe(32);
  });

  it("不同随机字节产生不同 token（同一来源的两个取值）", () => {
    let calls = 0;
    const randomBytes = (count: number) => {
      calls += 1;
      return new Uint8Array(count).map(() => (calls === 1 ? 0x00 : 0xff));
    };
    const a = generatePlayerToken(randomBytes);
    const b = generatePlayerToken(randomBytes);
    expect(a).not.toBe(b);
  });

  it("生成结果符合 base64url 字符集（无 +、/、=）", () => {
    const token = generatePlayerToken(() => zeros(32));
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
