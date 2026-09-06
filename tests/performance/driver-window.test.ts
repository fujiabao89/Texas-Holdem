import { describe, expect, it } from "vitest";

import { serverInfoFrom, defaultGameConfig } from "./engine";
import type { RoomSession, ServerInfo, PlayerSession } from "./engine";
import { runReconnectStorm } from "./driver";
import { MetricsCollector } from "./metrics";
import type { MetricsCollector as MetricsType } from "./metrics";

/** 构造只含 Host、无真实 WS 的最小 RoomSession（测试用）。 */
function hostOnlyRoom(playerId: string, token: string): RoomSession {
  const host: PlayerSession = {
    roomId: "room-" + playerId,
    playerId,
    displayName: "h-" + playerId,
    seat: 0,
    token,
    ws: null,
  };
  return {
    roomId: host.roomId,
    inviteCode: "ABCDEF",
    config: defaultGameConfig(2),
    host,
    players: [],
    tournamentId: null,
    revision: "1",
    appliedCount: 0,
  };
}

describe("driver.runReconnectStorm（窗口调度，确定性测试）", () => {
  const server: ServerInfo = serverInfoFrom("http://127.0.0.1:3401");

  function fakePerform(advanceMs: number, now: { value: number }) {
    return async (
      _server: ServerInfo,
      _session: { roomId: string; token: string },
      _m: MetricsType,
    ) => {
      now.value += advanceMs;
      return { ok: true, latencyMs: 10 } as const;
    };
  }

  it("窗口内完成全部 attempts → 返回 scheduled == attempts", async () => {
    const now = { value: 0 };
    const room = hostOnlyRoom("p1", "tok-p1");
    const scheduled = await runReconnectStorm([room], server, new MetricsCollector(), 8, {
      windowMs: 60_000,
      clock: () => now.value,
      perform: fakePerform(6_000, now),
    });
    expect(scheduled).toBe(8); // 前 7 次推进后 now=42_000 < 60_000，全部完成
  });

  it("跨越截止时间的操作不计入完成数（第 2 次于 4s 开始、8s 完成 > 6s）", async () => {
    const now = { value: 0 };
    const room = hostOnlyRoom("p2", "tok-p2");
    const completed = await runReconnectStorm([room], server, new MetricsCollector(), 8, {
      windowMs: 6_000,
      clock: () => now.value,
      perform: fakePerform(4_000, now),
    });
    // 第 1 次于 0–4s 完成 → 计入；第 2 次于 4–8s 完成、跨过 6s 截止线 → 不计入并停止。
    expect(completed).toBe(1);
    expect(completed).toBeLessThan(8);
  });

  it("缺省无限窗口则全部完成", async () => {
    const now = { value: 0 };
    const room = hostOnlyRoom("p3", "tok-p3");
    const scheduled = await runReconnectStorm([room], server, new MetricsCollector(), 5, {
      clock: () => now.value,
      perform: fakePerform(4_000, now),
    });
    expect(scheduled).toBe(5);
  });
});
