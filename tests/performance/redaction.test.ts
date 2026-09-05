import { describe, expect, it } from "vitest";

import { isSensitiveKey, redactJson, sensitiveKeysIn } from "./redaction";

describe("perf redaction.isSensitiveKey", () => {
  it("命中 token/secret/hmac/deck/hole/burn/reasoning 等键名", () => {
    for (const key of ["playerToken", "token", "secret", "hmacSecret", "authorization", "deck", "holeCards", "burn", "aiReasoning"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });
  it("不误伤无关键", () => {
    for (const key of ["roomId", "playerId", "inviteCode", "roomRevision", "tournamentId", "requestId", "displayName", "seed", "serverPort"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe("perf redaction.redactJson", () => {
  it("递归删除敏感键，保留无关结构", () => {
    const input = {
      runId: "r1",
      seats: [
        { playerId: "p1", playerToken: "abc" },
        { playerId: "p2", holeCards: ["H9", "D2"] },
      ],
      meta: { secret: "x", inviteCode: "ABC123" },
    };
    const redacted = redactJson(input) as Record<string, unknown>;
    expect(redacted.runId).toBe("r1");
    const seats = redacted.seats as Record<string, unknown>[];
    expect(seats[0]).toEqual({ playerId: "p1" });
    expect(seats[1]).toEqual({ playerId: "p2" });
    expect(redacted.meta).toEqual({ inviteCode: "ABC123" });
  });

  it("数组递归、空对象保持、不改原结构", () => {
    const input = { a: [{ playerToken: "t" }, { x: 1 }], b: {} };
    const redacted = redactJson(input) as Record<string, unknown>;
    expect(input.a[0]).toEqual({ playerToken: "t" }); // 未就地修改
    expect(redacted.a).toEqual([{}, { x: 1 }]);
    expect(redacted.b).toEqual({});
  });

  it("把字符串里的 Bearer 授权串替换为占位符（占位符自身不命中 Bearer 正则）", () => {
    expect(redactJson("Authorization: Bearer abc.def.123")).toBe("Authorization: [REDACTED]");
    expect(/Bearer\s+\S+/i.test("Authorization: [REDACTED]")).toBe(false);
  });

  it("原语原样返回", () => {
    expect(redactJson(null)).toBeNull();
    expect(redactJson(42)).toBe(42);
    expect(redactJson(true)).toBe(true);
    expect(redactJson("普通文本")).toBe("普通文本");
  });
});

describe("perf redaction.sensitiveKeysIn", () => {
  it("产物中任何残留敏感键都被列出路径", () => {
    const leaked = { runId: "r", seats: [{ playerToken: "x", playerId: "p" }] };
    const keys = sensitiveKeysIn(leaked);
    expect(keys).toEqual(["seats[0].playerToken"]);
  });

  it("已脱敏结构返回空（写盘前断言用）", () => {
    const redacted = redactJson({
      runId: "r",
      seats: [{ playerToken: "x", playerId: "p" }],
      note: "Authorization: Bearer abc",
    }) as { seats: unknown; note: string };
    expect(sensitiveKeysIn(redacted)).toEqual([]);
  });
});
