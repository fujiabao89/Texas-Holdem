import { describe, expect, it } from "vitest";

import { roomSnapshot, testConfig } from "../testing-fixtures";
import { encodeSafeJson, HttpTransport } from "./http-transport";
import { PlayerTokenStore } from "./token-store";
import { createFakeClock } from "../../../../tests/support/fake-clock";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("HttpTransport", () => {
  it("parses the protocol success envelope and stores only the issued session token", async () => {
    const tokenStore = new PlayerTokenStore();
    const transport = new HttpTransport({
      apiBaseUrl: "https://example.test",
      tokenStore,
      createUuid: () => UUID,
      fetchFn: async () => new Response(JSON.stringify({ data: { roomId: "room-1", playerId: "player-1", playerToken: "a".repeat(43), roomSnapshot: roomSnapshot() } }), { status: 201 }),
    });
    const result = await transport.createRoom({ displayName: "玩家甲", config: testConfig });
    expect(result.ok).toBe(true);
    expect(tokenStore.get("room-1")).toBe("a".repeat(43));
  });

  it("maps failures by ErrorCode, not the mutable server message", async () => {
    const diagnostics: unknown[] = [];
    const transport = new HttpTransport({
      apiBaseUrl: "https://example.test",
      tokenStore: new PlayerTokenStore(),
      createUuid: () => UUID,
      onDiagnostic: (item) => diagnostics.push(item),
      fetchFn: async () => new Response(JSON.stringify({ error: { code: "ROOM_FULL", message: "untrusted wording", retryable: false, traceId: "trace-1" } }), { status: 409 }),
    });
    const result = await transport.joinRoom({ inviteCode: "ABC234", displayName: "玩家甲" });
    expect(result).toMatchObject({ ok: false, error: { code: "ROOM_FULL" } });
    expect(diagnostics).toEqual([{ method: "POST", path: "/api/v1/rooms/join", status: 409, code: "ROOM_FULL" }]);
  });

  it("rejects oversized request JSON before network dispatch", () => {
    expect(() => encodeSafeJson({ value: "x".repeat(64 * 1024) })).toThrow(/64 KiB/);
  });

  it("uses an injected Fake Clock to abort a timed-out create request", async () => {
    const clock = createFakeClock();
    const transport = new HttpTransport({
      apiBaseUrl: "https://example.test",
      tokenStore: new PlayerTokenStore(),
      createUuid: () => UUID,
      clock,
      defaultTimeoutMs: 100,
      fetchFn: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    const request = transport.createRoom({ displayName: "玩家甲", config: testConfig });
    clock.advance(100);
    await expect(request).resolves.toMatchObject({ ok: false, error: { code: "GAME_UNAVAILABLE", reason: "TIMEOUT" } });
    expect(clock.pendingTimers()).toBe(0);
  });

  it("does not dispatch a request whose caller signal was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const transport = new HttpTransport({
      apiBaseUrl: "https://example.test",
      tokenStore: new PlayerTokenStore(),
      createUuid: () => UUID,
      fetchFn: async () => {
        called = true;
        return new Response("{}");
      },
    });

    await expect(transport.createRoom({ displayName: "玩家甲", config: testConfig }, { signal: controller.signal }))
      .resolves.toMatchObject({ ok: false, error: { reason: "CANCELLED" } });
    expect(called).toBe(false);
  });

  it("keeps external cancellation active until a hanging response body is consumed", async () => {
    const controller = new AbortController();
    let resolveBodyStarted!: () => void;
    const bodyStarted = new Promise<void>((resolve) => { resolveBodyStarted = resolve; });
    let rejectBody!: (error: Error) => void;
    const transport = new HttpTransport({
      apiBaseUrl: "https://example.test",
      tokenStore: new PlayerTokenStore(),
      createUuid: () => UUID,
      fetchFn: async (_input, init) => ({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>((_resolve, reject) => {
          rejectBody = reject;
          init?.signal?.addEventListener("abort", () => rejectBody(new Error("aborted")), { once: true });
          resolveBodyStarted();
        }),
      }) as Response,
    });

    const request = transport.createRoom({ displayName: "玩家甲", config: testConfig }, { signal: controller.signal });
    await bodyStarted;
    controller.abort();

    await expect(request).resolves.toMatchObject({ ok: false, error: { reason: "CANCELLED" } });
  });
});

describe("HttpTransport hand history endpoints", () => {
  const TOKEN = "a".repeat(43);
  const handItem = {
    handId: "hand-1",
    handNumber: 1,
    startedAt: 1_000,
    endedAt: 2_000,
    smallBlind: 5,
    bigBlind: 10,
    communityCards: [],
    endReason: "SHOWDOWN",
    potTotal: 30,
    winnerPlayerIds: ["player-1"],
  };

  function captureTransport(roomHasToken: boolean) {
    const tokenStore = new PlayerTokenStore();
    if (roomHasToken) tokenStore.save("room-1", TOKEN, "player-1");
    const calls: { url: string; authorization: string | null; idempotencyKey: string | null }[] = [];
    const transport = new HttpTransport({
      apiBaseUrl: "https://example.test",
      tokenStore,
      createUuid: () => UUID,
      fetchFn: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(input), authorization: headers.get("Authorization"), idempotencyKey: headers.get("Idempotency-Key") });
        return new Response(JSON.stringify({ data: { tournamentId: "tournament-1", items: [handItem], nextCursor: "cursor-2" } }), { status: 200 });
      },
    });
    return { calls, transport };
  }

  it("requests the paged list with the default limit, the room token and no idempotency key", async () => {
    const { calls, transport } = captureTransport(true);
    const result = await transport.listHandHistory("tournament-1", "room-1");
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.data.nextCursor).toBe("cursor-2");
    expect(calls).toEqual([{ url: "https://example.test/api/v1/tournaments/tournament-1/hands?limit=20", authorization: `Bearer ${TOKEN}`, idempotencyKey: null }]);
  });

  it("forwards an explicit cursor and limit for the next page", async () => {
    const { calls, transport } = captureTransport(true);
    await transport.listHandHistory("tournament-1", "room-1", { cursor: "cursor-9", limit: 7 });
    expect(calls[0].url).toBe("https://example.test/api/v1/tournaments/tournament-1/hands?limit=7&cursor=cursor-9");
  });

  it("sends no Authorization header when the room has no stored token", async () => {
    const { calls, transport } = captureTransport(false);
    await transport.listHandHistory("tournament-1", "room-1");
    expect(calls[0].authorization).toBeNull();
  });

  it("requests a single projected hand detail by tournament and hand id", async () => {
    const tokenStore = new PlayerTokenStore();
    tokenStore.save("room-1", TOKEN, "player-1");
    const calls: string[] = [];
    const transport = new HttpTransport({
      apiBaseUrl: "https://example.test",
      tokenStore,
      createUuid: () => UUID,
      fetchFn: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ data: { tournamentId: "tournament-1", handId: "hand-1", startSequence: "1", endSequence: "2", events: [] } }), { status: 200 });
      },
    });
    const result = await transport.getHandHistoryDetail("tournament-1", "hand-1", "room-1");
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["https://example.test/api/v1/tournaments/tournament-1/hands/hand-1"]);
  });
});
