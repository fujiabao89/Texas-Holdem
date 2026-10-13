import { test, expect } from "./fixture";

test("R1/R4 双人15秒：正常摊牌→连续三手→完整行动时钟 @timeline-pr @key", async ({ timeline }) => {
  await timeline.create(2);
  await timeline.drive(1, "passive");
  expect
    .soft(
      timeline.players[0]!.events.some((frame) => frame.payload.event.type === "SHOWDOWN_STARTED"),
    )
    .toBe(true);
  await timeline.drive(3, "fold");
  await expect
    .poll(() => timeline.logs().filter((row) => row.event === "HAND_STARTED").length)
    .toBeGreaterThanOrEqual(4);
  const snapshots = timeline.players[0]!.frames.filter((frame) => frame.type === "GAME_SNAPSHOT");
  expect(
    snapshots.some(
      (frame) =>
        frame.phase === "SHOWDOWN_DISPLAY" && frame.actor === null && frame.deadline === null,
    ),
  ).toBe(true);
  const open = snapshots.find((frame) => frame.deadline !== null && frame.deadline !== undefined);
  expect(open).toBeDefined();
  expect(
    timeline.players[0]!.frames.some(
      (frame) =>
        (frame.type === "GAME_SNAPSHOT" || frame.type === "RECONNECT_RESULT") &&
        frame.handId === open!.handId &&
        frame.sequence === open!.sequence &&
        frame.at < open!.at &&
        frame.actor === null &&
        frame.deadline === null &&
        frame.hasLegalActions === false,
    ),
  ).toBe(true);
  await timeline.assert();
});

for (const rttMs of [50, 100, 300, 500]) {
  test(`弱网 ${rttMs}ms RTT：真实传输抖动不重置倒计时 ${rttMs === 500 ? "@timeline-pr" : "@timeline-rc"}`, async ({
    timeline,
  }) => {
    await timeline.create(2, { profile: { rttMs, jitterMs: rttMs / 10, seed: 62 } });
    const slow = timeline.players[1]!;
    await expect.poll(() => slow.game?.actionDeadline != null).toBe(true);
    await expect(slow.page.getByText(/^可提交剩余时间：/)).toBeVisible();
    const reading = await slow.page.evaluate(() => {
      const samples = (
        window as unknown as {
          __texTimeSamples: {
            sent: number;
            received: number;
            serverReceived: number;
            serverSent: number;
          }[];
        }
      ).__texTimeSamples;
      const sample = samples.at(-1)!;
      return {
        at: performance.now(),
        seconds: Number(document.body.textContent?.match(/可提交剩余时间：(\d+) 秒/)?.[1]),
        offset: (sample.serverReceived + sample.serverSent - sample.sent - sample.received) / 2,
        rtt: sample.received - sample.sent - (sample.serverSent - sample.serverReceived),
      };
    });
    // Independent four-timestamp estimate. Whole-second rounding/250ms DOM cadence,
    // prior smoothed probes and bounded proxy asymmetry get a fixed 1.5s budget.
    const expected = Math.max(
      0,
      slow.game!.actionDeadline! - reading.at - reading.offset - reading.rtt / 2,
    );
    expect(reading.seconds * 1000).toBeGreaterThanOrEqual(Math.max(0, expected - 1500));
    expect(reading.seconds * 1000).toBeLessThanOrEqual(expected + 1500);
    await timeline.drive(2, "fold");
    expect(slow.proxy.samples.filter((sample) => sample.direction === "up").length).toBeGreaterThan(
      0,
    );
    expect(
      slow.proxy.samples.filter((sample) => sample.direction === "down").length,
    ).toBeGreaterThan(0);
    for (const direction of ["up", "down"] as const)
      expect(
        slow.proxy.samples.some(
          (sample) =>
            sample.direction === direction &&
            sample.scheduledMs >= rttMs * 0.35 &&
            sample.elapsedMs >= sample.scheduledMs - 2,
        ),
      ).toBe(true);
    expect(slow.timeSyncReplies).toBeGreaterThan(0);
    await timeline.assert();
  });
}

test("R3 行动中断网：正常玩家继续推进，重连Snapshot保留原deadline @timeline-pr @key", async ({
  timeline,
}) => {
  await timeline.create(2);
  await expect
    .poll(() => timeline.players.every((player) => player.game?.actionDeadline != null))
    .toBe(true);
  const slow = timeline.players.find(
    (player) => player.game!.viewer.playerId !== player.game!.currentActorPlayerId,
  )!;
  const before = slow.game!;
  const reconnects = slow.frames.filter((frame) => frame.reason === "RECONNECT").length;
  slow.proxy.disconnect();
  const connected = timeline.players.find((player) => player !== slow)!;
  await connected.page
    .getByRole("button", { name: /^跟注 \d+$|^过牌$/ })
    .first()
    .click();
  await expect.poll(() => connected.game!.sequence).not.toBe(before.sequence);
  const deadline = connected.game!.actionDeadline;
  slow.proxy.reconnect();
  await expect
    .poll(() => slow.frames.filter((frame) => frame.reason === "RECONNECT").length, {
      timeout: 25_000,
    })
    .toBeGreaterThan(reconnects);
  expect(slow.game!.handId).toBe(connected.game!.handId);
  expect(slow.game!.sequence).toBe(connected.game!.sequence);
  expect(slow.game!.actionDeadline).toBe(deadline);
  await timeline.drive(1, "fold");
  await timeline.assert();
});

test("六人Reduced Motion全下：公开摊牌、守恒与无人可操作终局 @timeline-pr", async ({
  timeline,
}) => {
  await timeline.create(6, { reduced: true, stack: 20 });
  await timeline.drive(1, "all-in");
  const awards = timeline.players[0]!.events.flatMap((frame) =>
    frame.payload.event.type === "POT_AWARDED" ? [frame.payload.event.payload] : [],
  );
  expect(awards.reduce((sum, pot) => sum + pot.potAmount, 0)).toBe(120);
  expect(
    timeline.players[0]!.events.filter((frame) => frame.payload.event.type === "PLAYER_REVEALED")
      .length,
  ).toBe(6);
  await expect
    .poll(() => timeline.players.every((player) => player.game?.currentActorPlayerId === null))
    .toBe(true);
  for (const player of timeline.players)
    await expect(player.page.locator("[data-action-hand-id]")).toHaveCount(0);
  await timeline.assert();
});

test("R2 六人Reduced Motion跨手：合法弃牌快局后仍可操作 @timeline-pr", async ({ timeline }) => {
  await timeline.create(6, { reduced: true });
  await timeline.drive(3, "fold");
  await expect
    .poll(() => timeline.players.every((player) => player.game?.actionDeadline != null))
    .toBe(true);
  expect(timeline.players[0]!.game!.tournamentStatus).toBe("RUNNING");
  await timeline.assert();
});

for (const phase of ["SHOWDOWN_DISPLAY", "DEALING"] as const) {
  test(`R3 ${phase}边界断网恢复：最新Snapshot不补播旧手 @timeline-rc`, async ({ timeline }) => {
    await timeline.create(2);
    if (phase === "SHOWDOWN_DISPLAY") await timeline.drive(1, "passive");
    else await timeline.drive(1, "fold");
    const slow = timeline.players[1]!;
    if (phase === "SHOWDOWN_DISPLAY")
      await expect.poll(() => slow.game?.handPhase).toBe("SHOWDOWN_DISPLAY");
    else
      await expect
        .poll(
          () =>
            timeline
              .logs()
              .filter((row) => row.event === "PHASE_CHANGED")
              .at(-1)?.phase,
        )
        .toBe("DEALING");
    const beforeHand = slow.game!.handId;
    const reconnects = slow.frames.filter((frame) => frame.reason === "RECONNECT").length;
    slow.proxy.disconnect();
    await expect
      .poll(
        () =>
          (phase === "SHOWDOWN_DISPLAY"
            ? timeline.players[0]!.game?.handId !== beforeHand
            : timeline.players[0]!.game?.handId === beforeHand) &&
          timeline.players[0]!.game?.actionDeadline != null,
        { timeout: 20_000 },
      )
      .toBe(true);
    slow.proxy.reconnect();
    await expect
      .poll(() => slow.frames.filter((frame) => frame.reason === "RECONNECT").length, {
        timeout: 25_000,
      })
      .toBeGreaterThan(reconnects);
    await expect
      .poll(
        () =>
          slow.game!.handId === timeline.players[0]!.game!.handId &&
          slow.game!.sequence === timeline.players[0]!.game!.sequence,
      )
      .toBe(true);
    expect(slow.game!.actionDeadline).toBe(timeline.players[0]!.game!.actionDeadline);
    await timeline.drive(2, "fold");
    await timeline.assert();
  });
}

test("十人移动视口连续快局：Fold-to-win不虚构摊牌，不混手 @timeline-rc", async ({ timeline }) => {
  await timeline.create(10, { viewport: { width: 390, height: 844 } });
  await timeline.drive(3, "fold");
  expect(
    timeline.players[0]!.events.some((frame) => frame.payload.event.type === "SHOWDOWN_STARTED"),
  ).toBe(false);
  expect(
    timeline.logs().filter((row) => row.event === "HAND_STARTED").length,
  ).toBeGreaterThanOrEqual(3);
  await timeline.assert();
});

test("R2 六人真实低帧率：降级后结算/下一手语义终态 @timeline-rc", async ({ timeline }) => {
  await timeline.create(6);
  const page = timeline.players[0]!.page;
  await page.evaluate(() => {
    const timer = setInterval(() => {
      const end = performance.now() + 60;
      while (performance.now() < end) {
        /* real main-thread contention */
      }
    }, 75);
    Object.assign(window, { __texFrameLoad: timer });
  });
  try {
    await timeline.drive(1, "passive");
    await expect(page.locator("main[data-reduced-motion]")).toHaveAttribute(
      "data-reduced-motion",
      "true",
    );
    await timeline.drive(2, "fold");
    await timeline.assert();
  } finally {
    await page.evaluate(() =>
      clearInterval((window as unknown as { __texFrameLoad: number }).__texFrameLoad),
    );
  }
});

test("六人先弃牌再全下：真实主池/边池分配 @timeline-rc", async ({ timeline }) => {
  await timeline.create(6, { reduced: true, stack: 20 });
  await timeline.drive(1, "fold");
  await timeline.drive(2, "all-in");
  const awards = timeline.players[0]!.events.flatMap((frame) =>
    frame.payload.event.type === "POT_AWARDED" ? [frame.payload.event.payload] : [],
  );
  expect(
    awards.some((pot) => pot.potIndex > 0),
    "fixture must reach an actual side pot",
  ).toBe(true);
  expect(
    awards.every(
      (pot) => pot.awards.reduce((sum, award) => sum + award.amount, 0) === pot.potAmount,
    ),
  ).toBe(true);
  await timeline.assert();
});

test("慢接收真实背压：停读原生TCP，超限恢复不阻塞正常玩家 @timeline-rc", async ({
  timeline,
}, info) => {
  await timeline.create(6, { reduced: true });
  await expect
    .poll(() => timeline.players.every((player) => player.game?.actionDeadline != null))
    .toBe(true);
  const slow = timeline.players.find(
    (player) => player.game!.viewer.playerId !== player.game!.currentActorPlayerId,
  )!;
  const beforePressure = slow.frames.length;
  const playerId = slow.game!.viewer.playerId;
  const hasBackpressure = () =>
    timeline
      .logs()
      .some(
        (row) =>
          row.playerId === playerId &&
          (row.event === "RESYNC_REQUIRED" || row.event === "SLOW_CONNECTION_CLOSED"),
      );
  slow.proxy.pauseReads();
  // A fixed 4MiB burst can fit entirely inside Linux's kernel socket buffers.
  // Send bounded batches until this player's real outbox reports pressure.
  const pressure = (async () => {
    let sent = 0;
    for (let batch = 0; batch < 256 && !hasBackpressure(); batch++) {
      const count = await slow.page.evaluate(async () => {
        const socket = [...(window as unknown as { __texSockets: WebSocket[] }).__texSockets]
          .reverse()
          .find((item) => item.readyState === WebSocket.OPEN);
        if (socket === undefined) return 0;
        let count = 0;
        while (count < 256 && socket.bufferedAmount < 256 * 1024) {
          socket.send(
            JSON.stringify({
              type: "TIME_SYNC",
              requestId: crypto.randomUUID(),
              payload: { clientSentAt: performance.now() },
            }),
          );
          count++;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return count;
      });
      sent += count;
    }
    await info.attach("pressure-probe-count", {
      body: JSON.stringify({ sent, maxProbes: 65_536, observed: hasBackpressure() }),
      contentType: "application/json",
    });
  })();
  await timeline.action("fold");
  await pressure;
  await expect.poll(hasBackpressure, { timeout: 35_000 }).toBe(true);
  slow.proxy.resumeReads();
  await expect
    .poll(
      () =>
        slow.frames
          .slice(beforePressure)
          .some((frame) => frame.type === "RESYNC_REQUIRED" || frame.reason === "RECONNECT"),
      { timeout: 35_000 },
    )
    .toBe(true);
  await timeline.drive(1, "fold");
  await timeline.assert();
});
