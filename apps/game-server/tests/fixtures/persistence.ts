/**
 * 持久化相关测试替身（TEX-22）：Fake `HandCommitRepository`、Fake `RecoveryRepository`
 * 与 `HandCommitBundle` 构造器。
 *
 * 全部为纯内存、确定性实现；Writer/恢复测试不依赖真实数据库、网络或 sleep
 * （docs/06-testing-strategy.md §2.1）。本文件非 `*.test.ts`，不被 vitest 自动收集。
 */

import { sha256Checksum, stableStringify } from "../../src/infrastructure/persistence/checksum";
import { SequenceIntegrityError } from "../../src/infrastructure/persistence/repositories/errors";
import type {
  HandCommitBundle,
  HandCommitEvent,
  HandCommitOutcome,
  HandCommitRepository,
} from "../../src/infrastructure/persistence/repositories/hand-commit";
import type {
  ActiveTournamentRecord,
  CommittedSnapshotRecord,
  RecoveryRepository,
} from "../../src/infrastructure/persistence/repositories/recovery";

/** 构造一个结构合法、序列连续的 Commit Bundle（事件 sequence 从 firstSequence 起 +1 连续）。 */
export function makeBundle(
  tournamentId: string,
  handNumber: number,
  firstSequence: bigint,
  eventCount: number,
  over: Partial<HandCommitBundle> = {},
): HandCommitBundle {
  const events: HandCommitEvent[] = [];
  for (let i = 0; i < eventCount; i++) {
    events.push({
      sequence: firstSequence + BigInt(i),
      handSequence: i + 1,
      type: "PLAYER_CHECKED",
      payload: { seatIndex: 0, source: "human_socket" },
      schemaVersion: 1,
    });
  }
  const lastSequence = firstSequence + BigInt(eventCount - 1);
  // 结构完整的手末边界 TournamentState（restore 需要 config/participants/eliminations 等全部字段）。
  const snapshotState = stableStringify({
    config: {
      maxPlayers: 6,
      startingStack: 100,
      smallBlind: 10,
      bigBlind: 20,
      blindMode: "fixed",
      blindStructure: [{ smallBlind: 10, bigBlind: 20 }],
      actionTime: 30,
      timeBank: 60,
    },
    phase: "running",
    handNumber,
    handInProgress: false,
    blindLevel: 0,
    smallBlind: 10,
    bigBlind: 20,
    dealerSeat: 0,
    participants: [
      { seatIndex: 0, name: "P0", kind: "human", status: "ACTIVE", chips: 100, startingStack: 100 },
      { seatIndex: 1, name: "P1", kind: "human", status: "ACTIVE", chips: 100, startingStack: 100 },
      { seatIndex: 2, name: "P2", kind: "human", status: "ACTIVE", chips: 100, startingStack: 100 },
    ],
    forfeitedChips: 0,
    initialTotalChips: 100,
    champion: null,
    eliminations: [],
    finalStandings: [],
    elapsedSeconds: 0,
    nextSequence: Number(lastSequence), // 与快照水位一致（恢复校验要求 state.nextSequence == snapshot.sequence）
    hand: null,
    // v2 companion state：服务端权威的每玩家剩余 Time Bank（config.timeBank=60 启用时
    // 必须覆盖每个锁定参赛者，键 = playerId，与 makeActiveTournament 的 playerId 对齐）。
    serverTimeBank: {
      [`${tournamentId}-p0`]: 60,
      [`${tournamentId}-p1`]: 60,
      [`${tournamentId}-p2`]: 60,
    },
  });
  const snapshot = {
    id: `snapshot-${tournamentId}-${handNumber}`,
    sequence: firstSequence + BigInt(eventCount - 1),
    state: snapshotState,
    schemaVersion: 2, // v2：state 携带 serverTimeBank companion（P1-C）
    engineVersion: "0.1.0",
    // 与生产 bundle 构造一致：对解析后状态对象计算（恢复侧等价复算）。
    stateChecksum: sha256Checksum(JSON.parse(snapshotState) as object),
    commitChecksum: sha256Checksum({ tournamentId, handNumber, events, snapshotState }),
  };
  return {
    tournamentId,
    hand: {
      id: `hand-${tournamentId}-${handNumber}`,
      handNumber,
      dealerSeat: 0,
      sbSeat: 1,
      bbSeat: 2,
      blindLevelIndex: 0,
      smallBlind: 10n,
      bigBlind: 20n,
      communityCards: [],
      summary: { showdown: false, pots: [] },
      endReason: "ALL_FOLDED",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      endedAt: new Date("2026-01-01T00:01:00Z"),
    },
    events,
    snapshot,
    playerUpdates: [],
    ...over,
  };
}

export interface FakeCommitRepository extends HandCommitRepository {
  readonly committed: readonly HandCommitBundle[];
  /** 后续 N 次提交抛瞬态错误（TypeError 模拟网络故障），随后恢复成功。 */
  failTransient: number;
  /** 下一次提交抛数据损坏错误（SequenceIntegrityError），随后按 failTransient 语义处理。 */
  failIntegrityOnce: boolean;
  /** 显式自定义瞬态错误（供断言 error 传递）。 */
  transientError: Error | null;
  /** 是否处于拒绝状态（一直抛瞬态错误）。 */
  alwaysFail: boolean;
  /** 是否挂起：commitHandBundle 永不 resolve（模拟未取消的 in-flight 查询）。 */
  hangForever: boolean;
  /** 重复投递的手 id（同一 hand id 再次提交返回 already-committed，不重复记录）。 */
  readonly duplicated: readonly string[];
  reset(): void;
}

/** 可编程 Fake `HandCommitRepository`：确定性控制成功/瞬态失败/数据损坏。 */
export function createFakeCommitRepository(): FakeCommitRepository {
  let committed: HandCommitBundle[] = [];
  let duplicated: string[] = [];
  const state = {
    failTransient: 0,
    failIntegrityOnce: false,
    transientError: null as Error | null,
    alwaysFail: false,
    hangForever: false,
  };
  return {
    get committed() {
      return committed;
    },
    get failTransient() {
      return state.failTransient;
    },
    set failTransient(v: number) {
      state.failTransient = v;
    },
    get failIntegrityOnce() {
      return state.failIntegrityOnce;
    },
    set failIntegrityOnce(v: boolean) {
      state.failIntegrityOnce = v;
    },
    get transientError() {
      return state.transientError;
    },
    set transientError(v: Error | null) {
      state.transientError = v;
    },
    get alwaysFail() {
      return state.alwaysFail;
    },
    set alwaysFail(v: boolean) {
      state.alwaysFail = v;
    },
    get hangForever() {
      return state.hangForever;
    },
    set hangForever(v: boolean) {
      state.hangForever = v;
    },
    get duplicated() {
      return duplicated;
    },
    reset() {
      committed = [];
      duplicated = [];
      state.failTransient = 0;
      state.failIntegrityOnce = false;
      state.transientError = null;
      state.alwaysFail = false;
      state.hangForever = false;
    },
    async commitHandBundle(bundle: HandCommitBundle): Promise<HandCommitOutcome> {
      if (state.hangForever) {
        return new Promise<HandCommitOutcome>(() => {}); // 永不 resolve
      }
      if (state.failIntegrityOnce) {
        state.failIntegrityOnce = false;
        throw new SequenceIntegrityError("fake integrity failure");
      }
      if (state.alwaysFail || state.failTransient > 0) {
        if (state.failTransient > 0) state.failTransient -= 1;
        throw state.transientError ?? new Error("fake transient db failure (ECONNRESET)");
      }
      // 幂等重复投递：同 hand id 已提交 → 返回 already-committed，不重复记录（§7.4）。
      if (committed.some((c) => c.hand.id === bundle.hand.id)) {
        duplicated = [...duplicated, bundle.hand.id];
        return "already-committed";
      }
      committed = [...committed, bundle];
      return "committed";
    },
  };
}

export interface FakeRecoveryRepository extends RecoveryRepository {
  readonly active: ActiveTournamentRecord[];
  readonly snapshots: CommittedSnapshotRecord[];
  /** 连续事件数（hasCommittedEventsThrough 与 sequence 比较用）。 */
  eventCount: bigint;
  /** 读取抛错（模拟读取失败）。 */
  readError: Error | null;
  /** 已执行的回退调用（供断言）。 */
  readonly rollbacks: readonly { tournamentId: string; toSequence: bigint }[];
  /** listSnapshots 返回前可注入的篡改器（模拟损坏/孤立数据）。 */
  setActive(records: ActiveTournamentRecord[]): void;
  setSnapshots(records: CommittedSnapshotRecord[]): void;
}

/** Fake `RecoveryRepository`：确定性提供活跃比赛/快照/事件连续性。 */
export function createFakeRecoveryRepository(): FakeRecoveryRepository {
  let active: ActiveTournamentRecord[] = [];
  let snapshots: CommittedSnapshotRecord[] = [];
  let rollbacks: { tournamentId: string; toSequence: bigint }[] = [];
  const state = {
    eventCount: 0n,
    readError: null as Error | null,
  };
  return {
    get active() {
      return active;
    },
    get snapshots() {
      return snapshots;
    },
    get eventCount() {
      return state.eventCount;
    },
    set eventCount(v: bigint) {
      state.eventCount = v;
    },
    get readError() {
      return state.readError;
    },
    set readError(v: Error | null) {
      state.readError = v;
    },
    get rollbacks() {
      return rollbacks;
    },
    setActive(records) {
      active = records;
    },
    setSnapshots(records) {
      snapshots = records;
    },
    async listActiveTournaments(): Promise<ActiveTournamentRecord[]> {
      if (state.readError !== null) throw state.readError;
      return active;
    },
    async listSnapshots(tournamentId: string): Promise<CommittedSnapshotRecord[]> {
      if (state.readError !== null) throw state.readError;
      return snapshots.filter((s) => s.tournamentId === tournamentId);
    },
    async hasCommittedEventsThrough(tournamentId: string, upToSequence: bigint): Promise<boolean> {
      void tournamentId;
      if (state.readError !== null) throw state.readError;
      return state.eventCount >= upToSequence;
    },
    async listWithdrawnForfeited(): Promise<Map<number, bigint>> {
      return new Map();
    },
    async rollbackToSnapshot(tournamentId: string, toSequence: bigint): Promise<void> {
      rollbacks = [...rollbacks, { tournamentId, toSequence }];
    },
  };
}

/** 从 bundle 构造 CommittedSnapshotRecord（恢复测试复用）。 */
export function snapshotRecordFromBundle(bundle: HandCommitBundle): CommittedSnapshotRecord {
  return {
    tournamentId: bundle.tournamentId,
    handId: bundle.hand.id,
    sequence: bundle.snapshot.sequence,
    state: JSON.parse(String(bundle.snapshot.state)),
    schemaVersion: bundle.snapshot.schemaVersion,
    engineVersion: bundle.snapshot.engineVersion,
    stateChecksum: bundle.snapshot.stateChecksum,
    commitChecksum: bundle.snapshot.commitChecksum,
    createdAt: bundle.hand.endedAt,
  };
}

/** 活跃比赛记录构造器（恢复测试复用）。 */
export function makeActiveTournament(
  tournamentId: string,
  roomId: string,
  lastCommittedSequence: bigint,
  over: Partial<ActiveTournamentRecord> = {},
): ActiveTournamentRecord {
  return {
    tournamentId,
    roomId,
    configJson: {
      maxPlayers: 6,
      startingStack: 100,
      smallBlind: 10,
      bigBlind: 20,
      blindMode: "fixed",
      blindStructure: [{ smallBlind: 10, bigBlind: 20 }],
      actionTime: 30,
      timeBank: 60,
    },
    lastCommittedSequence,
    players: [
      { id: `${tournamentId}-tp0`, playerId: `${tournamentId}-p0`, displayName: "P0", seatIndex: 0, kind: "HUMAN", startingStack: 100n },
      { id: `${tournamentId}-tp1`, playerId: `${tournamentId}-p1`, displayName: "P1", seatIndex: 1, kind: "HUMAN", startingStack: 100n },
      { id: `${tournamentId}-tp2`, playerId: `${tournamentId}-p2`, displayName: "P2", seatIndex: 2, kind: "HUMAN", startingStack: 100n },
    ],
    ...over,
  };
}
