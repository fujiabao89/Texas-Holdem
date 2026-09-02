import { and, asc, eq, ne, notExists, or, sql } from "drizzle-orm";
import type { Database } from "../database";
import { gameSnapshots, handEvents, hands, rooms, tournaments, tournamentPlayers } from "../schema";
import {
  CommitChecksumMismatchError,
  HandSequenceIntegrityError,
  PartialCommitConflictError,
  PersistenceError,
  SequenceIntegrityError,
  TournamentNotFoundError,
  TournamentPlayerUpdateTargetError,
} from "./errors";

/**
 * 手末 Commit Bundle 仓储（docs/03-data-model.md §7.3/§7.4）。
 *
 * 单个 PostgreSQL 事务内原子写入：
 *   hands + 完整连续 hand_events + 一条 game_snapshots + 该手造成的
 *   tournament_players 结果更新 + tournaments.last_committed_sequence
 *   （如该手终结比赛，同事务更新 Tournament/Room 结果状态）。
 * 任一语句或验证失败则整体回滚，不存在可恢复的"半手"。
 *
 * 幂等重试（§7.4）：调用方携带预生成的 hand_id/snapshot_id 与确定性事件序列
 * 重试；结果是"全部首次插入"或"已完整提交且 commit_checksum 相同"；
 * 部分冲突或同 ID 不同内容时抛错并告警，绝不静默 ON CONFLICT DO NOTHING。
 *
 * 本仓储不负责异步队列/退避/watermark（运行时任务，见 04 §12/§16）。
 */

export interface HandCommitEvent {
  /** Tournament 作用域 Event Stream 序列（跨手连续，§5.6）。 */
  readonly sequence: bigint;
  /** 本手内从 1 连续递增（§5.6）。 */
  readonly handSequence: number;
  readonly type: string;
  readonly payload: unknown;
  readonly schemaVersion: number;
}

export interface HandCommitSnapshot {
  readonly id: string;
  /** 等于本手最后一个 Event 的 sequence（§5.7）。 */
  readonly sequence: bigint;
  readonly state: unknown;
  readonly schemaVersion: number;
  readonly engineVersion: string;
  readonly stateChecksum: Buffer;
  readonly commitChecksum: Buffer;
}

export interface TournamentPlayerResultUpdate {
  readonly tournamentPlayerId: string;
  readonly pokerStatus: "ACTIVE" | "ELIMINATED" | "WITHDRAWN";
  readonly finalStack: bigint | null;
  readonly forfeitedChips: bigint;
  readonly rank: number | null;
  readonly eliminatedHandId: string | null;
}

/**
 * 关房元数据（docs/03-data-model.md §5.1）：`roomStatus = "CLOSED"` 时必填，
 * 与关房状态在同一事务内原子写入；缺失会被 DB CHECK（`rooms_closed_at_check`
 * 等）拒绝并回滚整个 Bundle。
 */
export interface RoomClosureMetadata {
  readonly closedAt: Date;
  /** 服务端原因码（P0 至少 `ABANDONED_NO_HUMAN`，§5.1）。 */
  readonly closedReason: string;
  readonly retentionExpiresAt: Date;
}

/** 该手终结比赛时的终局更新（§7.3）；非终局手不传。 */
export interface TournamentFinishUpdate {
  readonly status: "FINISHED" | "ABANDONED_NO_HUMAN";
  readonly championTournamentPlayerId: string | null;
  readonly finishedAt: Date;
  readonly retentionExpiresAt: Date;
  /** 比赛结束后 Room 的状态（如 IN_GAME → FINISHED）。不传则不改 Room。 */
  readonly roomStatus?: "LOBBY" | "FINISHED" | "CLOSED";
  /** 仅 `roomStatus = "CLOSED"` 时允许且必填（§5.1）。 */
  readonly roomClosure?: RoomClosureMetadata;
}

export interface HandCommitBundle {
  readonly tournamentId: string;
  readonly hand: {
    readonly id: string;
    readonly handNumber: number;
    readonly dealerSeat: number;
    readonly sbSeat: number;
    readonly bbSeat: number;
    readonly blindLevelIndex: number;
    readonly smallBlind: bigint;
    readonly bigBlind: bigint;
    readonly communityCards: unknown;
    readonly summary: unknown;
    readonly endReason: "ALL_FOLDED" | "SHOWDOWN" | "ABANDONED";
    readonly startedAt: Date;
    readonly endedAt: Date;
  };
  /** 按提交顺序排列的整手事件（含 HAND_STARTED 起始，至少 1 条）。 */
  readonly events: readonly HandCommitEvent[];
  readonly snapshot: HandCommitSnapshot;
  readonly playerUpdates: readonly TournamentPlayerResultUpdate[];
  readonly tournamentFinish?: TournamentFinishUpdate;
}

export type HandCommitOutcome = "committed" | "already-committed";

export interface HandCommitRepository {
  commitHandBundle(bundle: HandCommitBundle): Promise<HandCommitOutcome>;
}

export function createHandCommitRepository(database: Database): HandCommitRepository {
  async function commitHandBundle(bundle: HandCommitBundle): Promise<HandCommitOutcome> {
    return database.withTransaction(async (tx) => {
      // §7.3：先锁定 Tournament 行，串行化同一 Tournament 的手末提交。
      const [tournament] = await tx
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, bundle.tournamentId))
        .for("update");
      if (tournament === undefined) {
        throw new TournamentNotFoundError(bundle.tournamentId);
      }

      // §7.4 幂等检查：该手是否已有完整提交（以 Snapshot 存在为准）。
      const [existingSnapshot] = await tx
        .select()
        .from(gameSnapshots)
        .where(
          and(
            eq(gameSnapshots.tournamentId, bundle.tournamentId),
            eq(gameSnapshots.handId, bundle.hand.id),
          ),
        );
      if (existingSnapshot !== undefined) {
        if (existingSnapshot.id !== bundle.snapshot.id) {
          throw new PartialCommitConflictError(bundle.hand.id);
        }
        if (Buffer.compare(existingSnapshot.commitChecksum, bundle.snapshot.commitChecksum) !== 0) {
          throw new CommitChecksumMismatchError(bundle.hand.id);
        }
        if (tournament.lastCommittedSequence !== bundle.snapshot.sequence) {
          throw new SequenceIntegrityError(
            "watermark does not match the already-committed snapshot sequence",
          );
        }
        return "already-committed" as const;
      }

      // §7.4：hand 行已存在但 Snapshot 缺失 → 部分冲突，原子性被破坏的信号。
      const [existingHand] = await tx
        .select({ id: hands.id })
        .from(hands)
        .where(eq(hands.id, bundle.hand.id));
      if (existingHand !== undefined) {
        throw new PartialCommitConflictError(bundle.hand.id);
      }

      validateBundleIntegrity(bundle, tournament.lastCommittedSequence);
      validateTournamentFinish(bundle.tournamentFinish);

      // §7.3：验证该手全部事件与库内水位线咬合（首序列 = 水位线 + 1）。
      await tx.insert(hands).values({
        id: bundle.hand.id,
        tournamentId: bundle.tournamentId,
        handNumber: bundle.hand.handNumber,
        dealerSeat: bundle.hand.dealerSeat,
        sbSeat: bundle.hand.sbSeat,
        bbSeat: bundle.hand.bbSeat,
        blindLevelIndex: bundle.hand.blindLevelIndex,
        smallBlind: bundle.hand.smallBlind,
        bigBlind: bundle.hand.bigBlind,
        communityCards: bundle.hand.communityCards,
        summary: bundle.hand.summary,
        endReason: bundle.hand.endReason,
        startedAt: bundle.hand.startedAt,
        endedAt: bundle.hand.endedAt,
      });
      await tx.insert(handEvents).values(
        bundle.events.map((event) => ({
          tournamentId: bundle.tournamentId,
          handId: bundle.hand.id,
          sequence: event.sequence,
          handSequence: event.handSequence,
          type: event.type,
          payload: event.payload,
          schemaVersion: event.schemaVersion,
        })),
      );
      await tx.insert(gameSnapshots).values({
        id: bundle.snapshot.id,
        tournamentId: bundle.tournamentId,
        handId: bundle.hand.id,
        sequence: bundle.snapshot.sequence,
        state: bundle.snapshot.state,
        schemaVersion: bundle.snapshot.schemaVersion,
        engineVersion: bundle.snapshot.engineVersion,
        stateChecksum: bundle.snapshot.stateChecksum,
        commitChecksum: bundle.snapshot.commitChecksum,
      });
      for (const update of bundle.playerUpdates) {
        // §7.4 不得静默：目标行必须存在且属于本 Tournament。
        // WHERE 同时按 id + tournament_id 匹配并断言恰好命中 1 行——
        // 防止跨赛修改赛果（脏 id 指向其他 Tournament）或静默 0 行更新。
        const updatedRows = await tx
          .update(tournamentPlayers)
          .set({
            pokerStatus: update.pokerStatus,
            finalStack: update.finalStack,
            forfeitedChips: update.forfeitedChips,
            rank: update.rank,
            eliminatedHandId: update.eliminatedHandId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tournamentPlayers.id, update.tournamentPlayerId),
              eq(tournamentPlayers.tournamentId, bundle.tournamentId),
            ),
          )
          .returning({ id: tournamentPlayers.id });
        if (updatedRows.length !== 1) {
          throw new TournamentPlayerUpdateTargetError(update.tournamentPlayerId);
        }
      }
      await tx
        .update(tournaments)
        .set({ lastCommittedSequence: bundle.snapshot.sequence })
        .where(eq(tournaments.id, bundle.tournamentId));

      if (bundle.tournamentFinish !== undefined) {
        const finish = bundle.tournamentFinish;
        await tx
          .update(tournaments)
          .set({
            status: finish.status,
            championTournamentPlayerId: finish.championTournamentPlayerId,
            finishedAt: finish.finishedAt,
            retentionExpiresAt: finish.retentionExpiresAt,
          })
          .where(eq(tournaments.id, bundle.tournamentId));
        if (finish.roomStatus === "CLOSED" && finish.roomClosure !== undefined) {
          // §5.1：CLOSED 必须同事务写齐 closed_at/closed_reason/retention_expires_at，
          // 只写 status 会违反 rooms_closed_* CHECK 并回滚整个 Bundle。
          const closure = finish.roomClosure;
          await tx
            .update(rooms)
            .set({
              status: "CLOSED",
              closedAt: closure.closedAt,
              closedReason: closure.closedReason,
              retentionExpiresAt: closure.retentionExpiresAt,
            })
            .where(eq(rooms.id, tournament.roomId));
        } else if (finish.roomStatus !== undefined) {
          // 延迟落库的终局 Bundle 不得覆写已推进的房间状态，但必须保留对控制面
          // TOURNAMENT_FINISHED 瞬时失败（main.ts 记录后丢弃、由本 Bundle 兜底）的
          // 补偿能力（docs/03 §7.3）：
          // - 房间 FINISHED：正常时序（控制面先提交后确认），幂等重申；
          // - 房间 IN_GAME 且同房间无其他运行中比赛：控制面写失败、房间仍挂在本赛
          //   上 → 兜底写入终态；
          // - 房间 IN_GAME 且已有新赛运行（再来一局竞态）或房间 CLOSED/LOBBY：
          //   已推进，跳过不覆写。
          await tx
            .update(rooms)
            .set({ status: finish.roomStatus })
            .where(
              and(
                eq(rooms.id, tournament.roomId),
                or(
                  eq(rooms.status, "FINISHED"),
                  and(
                    eq(rooms.status, "IN_GAME"),
                    notExists(
                      tx
                        .select({ one: sql`1` })
                        .from(tournaments)
                        .where(
                          and(
                            eq(tournaments.roomId, tournament.roomId),
                            ne(tournaments.id, bundle.tournamentId),
                            eq(tournaments.status, "IN_GAME"),
                          ),
                        ),
                    ),
                  ),
                ),
              ),
            );
        }
      }

      return "committed" as const;
    });
  }

  return { commitHandBundle };
}

/**
 * 终局更新前置验证（写入前失败，不依赖回滚）：
 * - ABANDONED_NO_HUMAN 不得宣告冠军（§5.3）；
 * - 终态时间有效且保留期不早于终止时间（与 `tournaments_retention_check` 一致，
 *   §5.3）——否则整包写入后才被 DB CHECK（23514）回滚；
 * - roomStatus=CLOSED 必须携带 roomClosure（closed_at/closed_reason/
 *   retention_expires_at，§5.1），否则 DB CHECK 会拒绝并回滚整个 Bundle；
 * - roomClosure 只在 CLOSED 时允许——其他状态写入关房字段同样违反 CHECK；
 * - roomClosure 内容校验（时间有效/顺序、原因码非空且无控制字符），
 *   与 `rooms_retention_check`/`rooms_closed_reason_check` 对齐，但前置拒绝。
 */
function validateTournamentFinish(finish: TournamentFinishUpdate | undefined): void {
  if (finish === undefined) {
    return;
  }
  if (finish.status !== "FINISHED" && finish.championTournamentPlayerId !== null) {
    throw new PersistenceError(
      "champion cannot be set for an abandoned tournament (ABANDONED_NO_HUMAN)",
    );
  }
  assertValidTimestamp(finish.finishedAt, "tournamentFinish.finishedAt");
  assertValidTimestamp(finish.retentionExpiresAt, "tournamentFinish.retentionExpiresAt");
  if (finish.retentionExpiresAt.getTime() < finish.finishedAt.getTime()) {
    throw new PersistenceError(
      "tournamentFinish.retentionExpiresAt must be >= finishedAt (docs/03 §5.3)",
    );
  }
  if (finish.roomStatus === "CLOSED" && finish.roomClosure === undefined) {
    throw new PersistenceError(
      "roomStatus CLOSED requires roomClosure (closed_at/closed_reason/retention_expires_at, docs/03 §5.1)",
    );
  }
  if (finish.roomStatus !== "CLOSED" && finish.roomClosure !== undefined) {
    throw new PersistenceError("roomClosure is only allowed when roomStatus is CLOSED");
  }
  if (finish.roomClosure !== undefined) {
    validateRoomClosure(finish.roomClosure);
  }
}

/**
 * 关房元数据内容校验（§5.1）：
 * - closed_at/retention_expires_at 必须是有效时间，且保留期不早于关房时间
 *   （与 `rooms_retention_check` 一致；空原因码能绕过 NOT NULL、
 *   控制字符是堆栈/自由文本痕迹，均在入库前拒绝）。
 */
function validateRoomClosure(closure: RoomClosureMetadata): void {
  assertValidTimestamp(closure.closedAt, "roomClosure.closedAt");
  assertValidTimestamp(closure.retentionExpiresAt, "roomClosure.retentionExpiresAt");
  if (closure.retentionExpiresAt.getTime() < closure.closedAt.getTime()) {
    throw new PersistenceError(
      "roomClosure.retentionExpiresAt must be >= closedAt (docs/03 §5.1)",
    );
  }
  if (closure.closedReason.trim() === "" || CONTROL_CHARACTER_PATTERN.test(closure.closedReason)) {
    throw new PersistenceError(
      "roomClosure.closedReason must be a non-empty reason code without control characters (docs/03 §5.1)",
    );
  }
}

function assertValidTimestamp(value: Date, field: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new PersistenceError(`${field} must be a valid Date`);
  }
}

/** 控制字符（\p{Cc}，如换行/制表）——原因码不含它们；堆栈痕迹由此拒绝（§5.1）。 */
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

/**
 * 提交前完整性与对齐验证（§7.3）：
 * - events 非空；首 sequence = 水位线 + 1；sequence 跨事件严格 +1；
 * - 末 sequence = Snapshot.sequence（快照对齐不变量，§8）；
 * - hand_sequence 从 1 到 count(*) 无缺口；
 * - Snapshot.sequence > 0。
 * 任一不满足即抛 SequenceIntegrity/HandSequenceIntegrity 错误并整体回滚。
 */
function validateBundleIntegrity(
  bundle: HandCommitBundle,
  lastCommittedSequence: bigint,
): void {
  if (bundle.events.length === 0) {
    throw new SequenceIntegrityError("commit bundle must contain at least one event");
  }
  if (bundle.snapshot.sequence <= 0n) {
    throw new SequenceIntegrityError("snapshot sequence must be positive");
  }
  const first = bundle.events[0];
  if (first.sequence !== lastCommittedSequence + 1n) {
    throw new SequenceIntegrityError(
      `first event sequence must be watermark + 1 (watermark = ${lastCommittedSequence})`,
    );
  }
  for (let i = 0; i < bundle.events.length; i += 1) {
    const event = bundle.events[i];
    if (event.handSequence !== i + 1) {
      throw new HandSequenceIntegrityError(
        `hand_sequence must be contiguous from 1 (got ${event.handSequence} at index ${i})`,
      );
    }
    if (i > 0 && event.sequence !== bundle.events[i - 1].sequence + 1n) {
      throw new SequenceIntegrityError(
        `tournament sequence must increase by exactly 1 per event (index ${i})`,
      );
    }
  }
  const last = bundle.events[bundle.events.length - 1];
  if (last.sequence !== bundle.snapshot.sequence) {
    throw new SequenceIntegrityError("snapshot sequence must equal the last event sequence");
  }
}

/** 供恢复/诊断路径按序读取某 Tournament 的已提交事件（读取属后续任务使用）。 */
export function selectCommittedEvents(db: Database["db"], tournamentId: string) {
  return db
    .select()
    .from(handEvents)
    .where(eq(handEvents.tournamentId, tournamentId))
    .orderBy(asc(handEvents.sequence));
}
