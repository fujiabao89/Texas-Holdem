import { describe, expect, it } from "vitest";
import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_CODE_MAX_COLLISIONS,
  InviteCodeExhaustedError,
  generateInviteCode,
  generateUniqueInviteCode,
} from "./invite-code";

/** 逐字节脚本化随机源：按调用顺序吐出给定字节。 */
function scriptedRandomBytes(...bytes: number[]): (count: number) => Uint8Array {
  const queue = [...bytes];
  return (count: number) => {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) {
      const next = queue.shift();
      if (next === undefined) throw new Error("scripted random bytes exhausted");
      out[i] = next;
    }
    return out;
  };
}

describe("generateInviteCode", () => {
  it("产出恰好 6 位、且只含 31 字符字母表的字符", () => {
    const code = generateInviteCode(scriptedRandomBytes(0, 1, 2, 3, 4, 5));
    expect(code).toBe("ABCDEF");
    expect(code).toHaveLength(INVITE_CODE_LENGTH);
    for (const char of code) {
      expect(INVITE_CODE_ALPHABET).toContain(char);
    }
  });

  it("用 rejection sampling 拒绝 >= 248 的字节，避免取模偏差", () => {
    // 首位 248 被拒绝，下一个 0 → 'A'；其余 1..5 → B..F
    const code = generateInviteCode(scriptedRandomBytes(248, 0, 1, 2, 3, 4, 5));
    expect(code).toBe("ABCDEF");
  });

  it("对字母表长度（31）取模后索引正确映射到第 31 个字符", () => {
    // 247 % 31 === 30 → 字母表最后一个字符 '9'
    const code = generateInviteCode(scriptedRandomBytes(247, 247, 247, 247, 247, 247));
    expect(code).toBe("999999");
    expect(INVITE_CODE_ALPHABET[30]).toBe("9");
  });
});

describe("generateUniqueInviteCode", () => {
  it("冲突在前 9 次时重试，第 10 次取到未占用码", () => {
    // 前 9 次生成 "AAAAAA"（全被占用），第 10 次生成 "BBBBBB"（脚本：先 9×6 个 0，再 6 个 1）
    const randomBytes = scriptedRandomBytes(
      ...Array.from({ length: 9 }, () => [0, 0, 0, 0, 0, 0]).flat(),
      1, 1, 1, 1, 1, 1,
    );
    const code = generateUniqueInviteCode(randomBytes, (candidate) => candidate === "AAAAAA");
    expect(code).toBe("BBBBBB");
  });

  it("连续 10 次冲突时抛 InviteCodeExhaustedError（不降级为可预测序列）", () => {
    const alwaysTaken = () => true;
    // 10 次尝试 × 每次 6 个字节 = 60 字节（都映射为 'A'）
    const randomBytes = scriptedRandomBytes(...Array.from({ length: 60 }, () => 0));
    expect(() => generateUniqueInviteCode(randomBytes, alwaysTaken)).toThrow(InviteCodeExhaustedError);
    expect(INVITE_CODE_MAX_COLLISIONS).toBe(10);
  });
});
