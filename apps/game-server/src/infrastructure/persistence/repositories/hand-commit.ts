import { and, asc, eq } from "drizzle-orm";
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

/** 该手终结比赛时的终局更新（§7.3）；非终局手不传。 */
export interface TournamentFinishUpdate {
  readonly status: "FINISHED" | "ABANDONED_NO_HUMAN";
  readonly championTournamentPlayerId: string | null;
  readonly finishedAt: Date;
  readonly retentionExpiresAt: Date;
  /** 比赛结束后 Room 的状态（如 IN_GAME → FINISHED）。不传则不改 Room。 */
  readonly roomStatus?: "LOBBY" | "FINISHED" | "CLOSED";
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
        if (finish.status !== "FINISHED" && finish.championTournamentPlayerId !== null) {
          throw new PersistenceError(
            "champion cannot be set for an abandoned tournament (ABANDONED_NO_HUMAN)",
          );
        }
        await tx
          .update(tournaments)
          .set({
            status: finish.status,
            championTournamentPlayerId: finish.championTournamentPlayerId,
            finishedAt: finish.finishedAt,
            retentionExpiresAt: finish.retentionExpiresAt,
          })
          .where(eq(tournaments.id, bundle.tournamentId));
        if (finish.roomStatus !== undefined) {
          await tx
            .update(rooms)
            .set({ status: finish.roomStatus })
            .where(eq(rooms.id, tournament.roomId));
        }
      }

      return "committed" as const;
    });
  }

  return { commitHandBundle };
}

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
