import { criticalViolations } from "../fixtures/a11y";
import { expect, test } from "../fixtures/observability";
import type { Page } from "@playwright/test";

const roomSnapshot = {
  snapshotVersion: 1, roomId: "room-1", roomRevision: "1", status: "IN_GAME", inviteCode: "ABC234", hostPlayerId: "player-1",
  config: { maxPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10, blindMode: "fixed", blindStructure: [{ smallBlind: 5, bigBlind: 10 }], actionTime: 30, timeBank: 60 },
  activeTournamentId: "tournament-1",
  players: [
    { playerId: "player-1", displayName: "玩家甲", seat: 0, ready: true, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" },
    { playerId: "player-2", displayName: "玩家乙", seat: 1, ready: true, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" },
  ],
};

function gameSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    snapshotVersion: 1, reason: "INITIAL", tournamentId: "tournament-1", sequence: "1", handId: "hand-1", tournamentStatus: "RUNNING", handPhase: "FLOP",
    blindLevel: { index: 0, smallBlind: 5, bigBlind: 10, ante: 0 }, dealerSeat: 0,
    board: [{ rank: "A", suit: "SPADES" }, { rank: "K", suit: "HEARTS" }, { rank: "2", suit: "CLUBS" }],
    pots: [{ amount: 90, eligiblePlayerIds: ["player-1", "player-2"] }], currentActorPlayerId: "player-1", actionDeadline: 50_000,
    players: [
      { playerId: "player-1", displayName: "玩家甲", seat: 0, stack: 990, streetBet: 10, totalCommitted: 10, pokerStatus: "ACTIVE", hasHoleCards: true, revealedCards: [] },
      { playerId: "player-2", displayName: "玩家乙", seat: 1, stack: 995, streetBet: 5, totalCommitted: 5, pokerStatus: "ACTIVE", hasHoleCards: true, revealedCards: [] },
    ],
    viewer: {
      playerId: "player-1", role: "PLAYER", holeCards: [{ rank: "Q", suit: "SPADES" }, { rank: "J", suit: "SPADES" }],
      legalActions: { canFold: true, canCheck: false, canCall: true, callAmount: 5, canBet: false, minBetTo: null, canRaise: true, minRaiseTo: 20, maxRaiseTo: 990, canAllIn: true, allInTo: 1000 }, timeBankRemainingMs: 60_000,
    }, rankings: [], ...overrides,
  };
}

async function seedTableSession(page: Page): Promise<void> {
  await page.addInitScript('sessionStorage.setItem("texas-holdem:player-token:room-1", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");sessionStorage.setItem("texas-holdem:player-id:room-1", "player-1");');
}

test("牌桌由 WS 权威投影驱动，键盘提交跟注后等待 Event 状态", async ({ page }) => {
  const submitted: unknown[] = [];
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString()) as { type: string; requestId: string; payload?: { actionId?: string } };
      if (command.type === "AUTHENTICATE") {
        socket.send(JSON.stringify({ type: "RECONNECT_RESULT", protocolVersion: 2, serverTime: 1, payload: { connectionId: "connection-1", resumed: true, tookOver: false, roomSnapshot, gameSnapshot: gameSnapshot() } }));
      }
      if (command.type === "SUBMIT_ACTION") {
        submitted.push(command);
        socket.send(JSON.stringify({ type: "COMMAND_RESULT", protocolVersion: 2, serverTime: 2, payload: { requestId: command.requestId, actionId: command.payload?.actionId, status: "APPLIED", duplicate: false, appliedSequence: "2" } }));
        socket.send(JSON.stringify({ type: "GAME_EVENT", protocolVersion: 2, serverTime: 3, payload: { tournamentId: "tournament-1", sequence: "2", handId: "hand-1", event: { type: "PLAYER_CALLED", payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET", amount: 5, betTo: 15 } }, patch: { currentActorPlayerId: "player-2", viewer: { legalActions: null } } } }));
      }
    });
  });
  await page.goto("/room/room-1/table");
  const call = page.getByRole("button", { name: "跟注 5" });
  await expect(call).toBeVisible();
  await call.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({ type: "SUBMIT_ACTION", payload: { action: { type: "CALL" }, expectedSequence: "1" } });
  await expect(call).toHaveCount(0);
  expect(await criticalViolations(page)).toEqual([]);
});

test("全下需要第二次确认，且不会伪装成普通下注", async ({ page }) => {
  const submitted: unknown[] = [];
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString()) as { type: string };
      if (command.type === "AUTHENTICATE") socket.send(JSON.stringify({ type: "RECONNECT_RESULT", protocolVersion: 2, serverTime: 1, payload: { connectionId: "connection-1", resumed: true, tookOver: false, roomSnapshot, gameSnapshot: gameSnapshot() } }));
      if (command.type === "SUBMIT_ACTION") submitted.push(command);
    });
  });
  await page.goto("/room/room-1/table");
  await page.getByRole("button", { name: "全下至 1000" }).click();
  expect(submitted).toEqual([]);
  await page.getByRole("button", { name: "再次点击确认全下至 1000" }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({ type: "SUBMIT_ACTION", payload: { action: { type: "ALL_IN" } } });
});

test("普通加注达到全下目标时仍需二次确认", async ({ page }) => {
  const submitted: unknown[] = [];
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString()) as { type: string };
      if (command.type === "AUTHENTICATE") socket.send(JSON.stringify({ type: "RECONNECT_RESULT", protocolVersion: 2, serverTime: 1, payload: { connectionId: "connection-1", resumed: true, tookOver: false, roomSnapshot, gameSnapshot: gameSnapshot({ viewer: { ...gameSnapshot().viewer, legalActions: { ...gameSnapshot().viewer.legalActions!, maxRaiseTo: 1000, allInTo: 1000 } } }) } }));
      if (command.type === "SUBMIT_ACTION") submitted.push(command);
    });
  });
  await page.goto("/room/room-1/table");
  await page.getByRole("button", { name: "加注" }).click();
  await page.getByRole("slider", { name: "下注总额" }).press("End");
  await page.getByRole("button", { name: "确认加注至 1000" }).click();
  expect(submitted).toEqual([]);
  await page.getByRole("button", { name: "再次点击确认全下至 1000" }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({ type: "SUBMIT_ACTION", payload: { action: { type: "ALL_IN" } } });
});

test("改选普通加注会取消全下确认并提交加注", async ({ page }) => {
  const submitted: unknown[] = [];
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString()) as { type: string };
      if (command.type === "AUTHENTICATE") socket.send(JSON.stringify({ type: "RECONNECT_RESULT", protocolVersion: 2, serverTime: 1, payload: { connectionId: "connection-1", resumed: true, tookOver: false, roomSnapshot, gameSnapshot: gameSnapshot() } }));
      if (command.type === "SUBMIT_ACTION") submitted.push(command);
    });
  });
  await page.goto("/room/room-1/table");
  await page.getByRole("button", { name: "全下至 1000" }).click();
  await page.getByRole("button", { name: "加注" }).click();
  await expect(page.getByRole("button", { name: "全下至 1000" })).toBeVisible();
  await page.getByRole("button", { name: "确认加注至 20" }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({ type: "SUBMIT_ACTION", payload: { action: { type: "RAISE", raiseTo: 20 } } });
});

test("点击提交会采用仍聚焦的精确加注额", async ({ page }) => {
  const submitted: unknown[] = [];
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString()) as { type: string };
      if (command.type === "AUTHENTICATE") socket.send(JSON.stringify({ type: "RECONNECT_RESULT", protocolVersion: 2, serverTime: 1, payload: { connectionId: "connection-1", resumed: true, tookOver: false, roomSnapshot, gameSnapshot: gameSnapshot() } }));
      if (command.type === "SUBMIT_ACTION") submitted.push(command);
    });
  });
  await page.goto("/room/room-1/table");
  await page.getByRole("button", { name: "加注" }).click();
  await page.getByRole("button", { name: "输入精确金额" }).click();
  await page.getByRole("textbox", { name: "输入精确下注额" }).fill("40");
  await page.getByRole("button", { name: "确认加注至 20" }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({ type: "SUBMIT_ACTION", payload: { action: { type: "RAISE", raiseTo: 40 } } });
});

test("输入非法精确金额会取消全下确认", async ({ page }) => {
  const submitted: unknown[] = [];
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString()) as { type: string };
      if (command.type === "AUTHENTICATE") socket.send(JSON.stringify({ type: "RECONNECT_RESULT", protocolVersion: 2, serverTime: 1, payload: { connectionId: "connection-1", resumed: true, tookOver: false, roomSnapshot, gameSnapshot: gameSnapshot() } }));
      if (command.type === "SUBMIT_ACTION") submitted.push(command);
    });
  });
  await page.goto("/room/room-1/table");
  await page.getByRole("button", { name: "加注" }).click();
  await page.getByRole("button", { name: "全下至 1000" }).click();
  await page.getByRole("button", { name: "输入精确金额" }).click();
  await page.getByRole("textbox", { name: "输入精确下注额" }).fill("19");
  await expect(page.getByText("请输入合法范围内的整数金额。")).toBeVisible();
  await expect(page.getByRole("button", { name: "全下至 1000" })).toBeVisible();
  await page.getByRole("button", { name: "全下至 1000" }).click();
  expect(submitted).toEqual([]);
});

test("ClockUpdated 的权威 Time Bank 余额会收起操作按钮", async ({ page }) => {
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      if ((JSON.parse(raw.toString()) as { type: string }).type !== "AUTHENTICATE") return;
      socket.send(JSON.stringify({ type: "RECONNECT_RESULT", protocolVersion: 2, serverTime: 1, payload: { connectionId: "connection-1", resumed: true, tookOver: false, roomSnapshot, gameSnapshot: gameSnapshot() } }));
      socket.send(JSON.stringify({ type: "CLOCK_UPDATED", protocolVersion: 2, serverTime: 2, payload: { tournamentId: "tournament-1", handId: "hand-1", currentActorPlayerId: "player-1", actionDeadline: 55_000, timeBankRemainingMs: 0 } }));
    });
  });
  await page.goto("/room/room-1/table");
  await expect(page.getByRole("button", { name: "使用延时" })).toHaveCount(0);
});

test("已有待发送命令时不能重试已拒绝的旧命令", async ({ page }) => {
  const submitted: { type: string; requestId: string; payload?: { action?: { type: string }; actionId?: string } }[] = [];
  let timeBankUses = 0;
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString()) as { type: string; requestId: string; payload?: { action?: { type: string }; actionId?: string } };
      if (command.type === "AUTHENTICATE") socket.send(JSON.stringify({ type: "RECONNECT_RESULT", protocolVersion: 2, serverTime: 1, payload: { connectionId: "connection-1", resumed: true, tookOver: false, roomSnapshot, gameSnapshot: gameSnapshot() } }));
      if (command.type === "SUBMIT_ACTION") {
        submitted.push(command);
        if (command.payload?.action?.type === "CALL") socket.send(JSON.stringify({ type: "COMMAND_RESULT", protocolVersion: 2, serverTime: 2, payload: { requestId: command.requestId, actionId: command.payload.actionId, status: "REJECTED", duplicate: false, error: { code: "GAME_UNAVAILABLE", message: "ignored", retryable: true, traceId: "trace-1" } } }));
      }
      if (command.type === "USE_TIME_BANK") timeBankUses += 1;
    });
  });
  await page.goto("/room/room-1/table");
  await page.getByRole("button", { name: "跟注 5" }).click();
  const retry = page.getByRole("button", { name: "重试操作" });
  await expect(retry).toBeEnabled();
  await page.getByRole("button", { name: "使用延时" }).click();
  await expect(retry).toBeDisabled();
  await expect.poll(() => timeBankUses).toBe(1);
  expect(submitted).toHaveLength(1);
});

test("AUTH_FAILED 会清除 Token 并引导重新加入", async ({ page }) => {
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      if ((JSON.parse(raw.toString()) as { type: string }).type === "AUTHENTICATE") socket.send(JSON.stringify({ type: "ERROR", protocolVersion: 2, serverTime: 1, payload: { code: "AUTH_FAILED", message: "ignored", retryable: false, traceId: "trace-1" } }));
    });
  });
  await page.goto("/room/room-1/table");
  await expect(page.getByRole("alert").filter({ hasText: "未找到此房间的身份凭证" })).toBeVisible();
});

test("UNSUPPORTED_PROTOCOL_VERSION 会显示刷新入口", async ({ page }) => {
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      if ((JSON.parse(raw.toString()) as { type: string }).type === "AUTHENTICATE") socket.send(JSON.stringify({ type: "ERROR", protocolVersion: 2, serverTime: 2, payload: { code: "UNSUPPORTED_PROTOCOL_VERSION", message: "ignored", retryable: false, traceId: "trace-2" } }));
    });
  });
  await page.goto("/room/room-1/table");
  await expect(page.getByRole("alert").filter({ hasText: "当前页面版本过旧" })).toBeVisible();
  await expect(page.getByRole("link", { name: "刷新页面" })).toBeVisible();
});

test("房间关闭会以服务端 RoomSnapshot 覆盖牌桌", async ({ page }) => {
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString()) as { type: string };
      if (command.type === "AUTHENTICATE") {
        socket.send(JSON.stringify({ type: "RECONNECT_RESULT", protocolVersion: 2, serverTime: 1, payload: { connectionId: "connection-1", resumed: true, tookOver: false, roomSnapshot, gameSnapshot: gameSnapshot() } }));
        socket.send(JSON.stringify({ type: "ROOM_SNAPSHOT", protocolVersion: 2, serverTime: 2, payload: { ...roomSnapshot, roomRevision: "2", status: "CLOSED", inviteCode: null, activeTournamentId: null } }));
      }
    });
  });
  await page.goto("/room/room-1/table");
  await expect(page.getByRole("alert").filter({ hasText: "房间已关闭。" })).toBeVisible();
});

test("成员被移出会以服务端 RoomSnapshot 停止牌桌操作", async ({ page }) => {
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString()) as { type: string };
      if (command.type === "AUTHENTICATE") {
        socket.send(JSON.stringify({ type: "RECONNECT_RESULT", protocolVersion: 2, serverTime: 1, payload: { connectionId: "connection-1", resumed: true, tookOver: false, roomSnapshot, gameSnapshot: gameSnapshot() } }));
        socket.send(JSON.stringify({ type: "ROOM_SNAPSHOT", protocolVersion: 2, serverTime: 2, payload: { ...roomSnapshot, roomRevision: "2", players: [roomSnapshot.players[1]] } }));
      }
    });
  });
  await page.goto("/room/room-1/table");
  await expect(page.getByRole("alert").filter({ hasText: "你已不在该房间中。" })).toBeVisible();
});

test("Session Replaced 停止操作并显示明确反馈", async ({ page }) => {
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      if ((JSON.parse(raw.toString()) as { type: string }).type === "AUTHENTICATE") socket.send(JSON.stringify({ type: "SESSION_REPLACED", protocolVersion: 2, serverTime: 1, payload: {} }));
    });
  });
  await page.goto("/room/room-1/table");
  const dialog = page.getByRole("dialog", { name: "此牌局已在其他设备打开" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "在此设备重新接管" })).toBeVisible();
});
