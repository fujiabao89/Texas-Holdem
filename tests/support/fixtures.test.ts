import { describe, expect, it } from "vitest";
import { defineFixture, FixtureValidationError } from "./fixtures";

interface RoomFixture {
  roomName: string;
  maxPlayers: number;
  initialStack: number;
}

const validRoom = defineFixture<RoomFixture>({
  name: "room",
  defaults: () => ({ roomName: "默认房间", maxPlayers: 6, initialStack: 1000 }),
  validate: (value) => {
    const issues = [];
    if (value.maxPlayers < 2 || value.maxPlayers > 10) {
      issues.push({ path: "maxPlayers", message: `应在 [2,10]，收到 ${value.maxPlayers}` });
    }
    if (value.initialStack <= 0) {
      issues.push({ path: "initialStack", message: `应为正数，收到 ${value.initialStack}` });
    }
    return issues;
  },
});

describe("defineFixture / FixtureBuilder", () => {
  it("默认值可直接构建并通过校验", () => {
    expect(validRoom.build()).toEqual({
      roomName: "默认房间",
      maxPlayers: 6,
      initialStack: 1000,
    });
  });

  it("with() 覆盖默认值；Builder 不可变、可复用", () => {
    const headsUp = validRoom.with({ maxPlayers: 2, roomName: "单挑" });
    expect(headsUp.build().maxPlayers).toBe(2);

    // 原 Builder 不受 with 影响，可继续复用。
    expect(validRoom.build().maxPlayers).toBe(6);
    expect(validRoom.build().roomName).toBe("默认房间");
    // 同一 Builder 派生两个实例互不影响。
    expect(headsUp.with({ roomName: "A" }).build().roomName).toBe("A");
    expect(headsUp.build().roomName).toBe("单挑");
  });

  it("校验失败聚合全部问题并抛出含名字与路径的错误", () => {
    let caught: unknown;
    try {
      validRoom.with({ maxPlayers: 99, initialStack: -1 }).build();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FixtureValidationError);
    const validationError = caught as FixtureValidationError;
    expect(validationError.fixtureName).toBe("room");
    expect(validationError.issues).toHaveLength(2);
    expect(validationError.message).toContain("room");
    expect(validationError.message).toContain("maxPlayers");
    expect(validationError.message).toContain("initialStack");
  });

  it("未定义 validate 时仅做类型层构建", () => {
    const plain = defineFixture<{ level: number }>({
      name: "plain",
      defaults: () => ({ level: 1 }),
    });
    expect(plain.with({ level: 5 }).build()).toEqual({ level: 5 });
  });

  it("两个不同 Fixture 定义互不干扰", () => {
    const blinds = defineFixture<{ smallBlind: number; bigBlind: number }>({
      name: "blinds",
      defaults: () => ({ smallBlind: 5, bigBlind: 10 }),
    });
    expect(validRoom.build().initialStack).toBe(1000);
    expect(blinds.build()).toEqual({ smallBlind: 5, bigBlind: 10 });
  });
});
