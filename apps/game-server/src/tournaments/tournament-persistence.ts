/**
 * Tournament 手末 Commit Bundle 构造（docs/03-data-model.md §5.5–§5.7；docs/04 §12）。
 *
 * 执行器在整手结算后把「该手全部事件 + 对齐 Snapshot + 结果更新」组装为不可变
 * `HandCommitBundle` 交给 Persistence Writer（P0 以整手为原子提交单元，§12）。
 * 本模块是唯一写者入口的构造侧；异步队列 / 退避 / watermark 属 TEX-22 Writer。
 *
 * 关键不变量（§7.3/§8）：
 * - 事件 `sequence` 跨手全局、与水位线咬合（首事件 = 上次提交水位 + 1）；
 * - `hand_sequence` 本手内从 1 连续；
 * - `snapshot.sequence` == 本手最后一个事件的 sequence（快照对齐不变量）。
 *
 * 边界说明：手间事件（如两手中的 `PLAYER_WITHDRAWN`）作为**下一手 bundle 的前导事件**
 * 落入同一原子提交（其 sequence 仍在手 N 之后、手 N+1 之前，快照边界「Withdraw 均已
 * 应用、下一手 HAND_STARTED 尚未发生」成立）。DB Writer 侧（TEX-22）需据此验证。
 */

import type {
  HandCommitBundle,
  HandCommitEvent,
  TournamentFinishUpdate,
  TournamentPlayerResultUpdate,
} from "../infrastructure/persistence/repositories/hand-commit";
import { sha256Checksum, stableStringify } from "../infrastructure/persistence/checksum";
import type { PokerEvent, PotAward, TournamentState } from "@texas-holdem/poker-engine";
import type { TournamentRuntimeState } from "./tournament-runtime";

/** 生成该 Snapshot 的 Engine 版本标识（规则升级可追溯性，03 §5.7）。 */
export const ENGINE_VERSION = "0.1.0";
/** Event/Snapshot 序列化格式版本（03 §5.6）。 */
export const SCHEMA_VERSION = 1;

export interface HandCommitContext {
  readonly state: TournamentRuntimeState;
  readonly engineState: TournamentState;
  readonly handStartedAt: number;
  readonly handEndedAt: number;
  /** 自上次提交以来、本 bundle 覆盖的 Engine 事件（含前导手间事件）。 */
  readonly events: readonly PokerEvent[];
}

/**
 * 构造整手原子提交单元；事件 sequence 对齐不变量由本函数保证。
 * 终局手可携带 `tournamentFinish`（FINISHED/ABANDONED_NO_HUMAN + Room 状态），
 * 使 Tournament/Room 结果状态与该手在同一事务内原子更新（03 §5.7/§7.3）。
 */
export function buildHandCommitBundle(
  ctx: HandCommitContext,
  tournamentFinish?: TournamentFinishUpdate,
): HandCommitBundle {
  const hand = ctx.engineState.hand!;
  const outcome = hand.outcome!;
  // hands.id 复用 wire handId（执行器当前手 ID），保证 live 事件流 ↔ 库内手记录可关联。
  const handId = ctx.state.currentHandId!;
  const snapshotId = ctx.state.ids.uuid();
  const firstSequence = ctx.state.committedEventCount + 1; // 上次提交水位 + 1（wire sequence）
  const events: HandCommitEvent[] = ctx.events.map((event, index) => ({
    sequence: BigInt(firstSequence + index),
    handSequence: index + 1,
    type: event.type,
    payload: stripSequence(event),
    schemaVersion: SCHEMA_VERSION,
  }));
  const lastSequence = BigInt(firstSequence + ctx.events.length - 1);
  // 服务端权威的每玩家剩余 Time Bank（docs/04 §8.4「余额由 server 权威维护」）：
  // 崩溃恢复需还原，否则重启会把已消耗余额重置为满（P1-B）。
  const serverTimeBank: Record<string, number> = {};
  for (const [playerId, record] of ctx.state.players) {
    serverTimeBank[playerId] = record.timeBank.secondsRemaining;
  }
  const snapshotPayload = { ...ctx.engineState, serverTimeBank };
  const snapshotState = stableStringify(snapshotPayload);
  const playerUpdates = buildPlayerUpdates(ctx, handId);
  const handMeta = {
    id: handId,
    handNumber: hand.handNumber,
    dealerSeat: hand.dealerSeat,
    sbSeat: hand.sbSeat,
    bbSeat: hand.bbSeat,
    blindLevelIndex: ctx.engineState.blindLevel,
    smallBlind: BigInt(hand.smallBlind),
    bigBlind: BigInt(hand.bigBlind),
    communityCards: hand.communityCards,
    summary: buildSummary(outcome),
    endReason: outcome.showdown ? ("SHOWDOWN" as const) : ("ALL_FOLDED" as const),
    startedAt: new Date(ctx.handStartedAt),
    endedAt: new Date(ctx.handEndedAt),
  };
  const commitChecksumInput = {
    tournamentId: ctx.state.tournamentId,
    hand: handMeta,
    events,
    snapshotState,
    playerUpdates,
    tournamentFinish,
  };
  return {
    tournamentId: ctx.state.tournamentId,
    hand: handMeta,
    events,
    snapshot: {
      id: snapshotId,
      sequence: lastSequence,
      state: snapshotState,
      schemaVersion: SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      // state 以 jsonb 落库、读取时是解析后的对象；state_checksum 必须对解析后状态
      // 的 canonical 序列化计算，恢复侧才能等价复算（docs/03 §5.7「稳定序列化结果」）。
      stateChecksum: sha256Checksum(snapshotPayload),
      commitChecksum: sha256Checksum(commitChecksumInput),
    },
    playerUpdates,
    tournamentFinish,
  };
}

/** 本手造成的结果更新：淘汰 / 撤回（由事件驱动），终局时冠军名次补齐。 */
function buildPlayerUpdates(
  ctx: HandCommitContext,
  handId: string,
): TournamentPlayerResultUpdate[] {
  const updates: TournamentPlayerResultUpdate[] = [];
  const seen = new Set<string>();
  const add = (update: TournamentPlayerResultUpdate) => {
    if (seen.has(update.tournamentPlayerId)) return;
    seen.add(update.tournamentPlayerId);
    updates.push(update);
  };

  for (const event of ctx.events) {
    if (event.type === "PLAYER_ELIMINATED") {
      const record = playerBySeat(ctx, event.seatIndex);
      if (record === undefined) continue;
      add({
        tournamentPlayerId: record.tournamentPlayerId,
        pokerStatus: "ELIMINATED",
        finalStack: 0n,
        forfeitedChips: 0n,
        rank: event.placementRange.from,
        eliminatedHandId: handId,
      });
    } else if (event.type === "PLAYER_WITHDRAWN") {
      const record = playerBySeat(ctx, event.seatIndex);
      if (record === undefined) continue;
      add({
        tournamentPlayerId: record.tournamentPlayerId,
        pokerStatus: "WITHDRAWN",
        finalStack: 0n,
        forfeitedChips: BigInt(event.forfeitedChips),
        rank: null,
        eliminatedHandId: null,
      });
    }
  }

  // 终局：冠军名次 1（引擎 finalStandings 首条；非冠军不在此手终结）。
  if (ctx.engineState.phase === "finished" && ctx.engineState.champion !== null) {
    const championSeat = ctx.engineState.champion;
    const record = playerBySeat(ctx, championSeat);
    if (record !== undefined) {
      add({
        tournamentPlayerId: record.tournamentPlayerId,
        pokerStatus: "ACTIVE",
        finalStack: BigInt(championChips(ctx, championSeat)),
        forfeitedChips: 0n,
        rank: 1,
        eliminatedHandId: null,
      });
    }
  }
  return updates;
}

function championChips(ctx: HandCommitContext, seatIndex: number): number {
  const participant = ctx.engineState.participants.find((p) => p.seatIndex === seatIndex);
  return participant?.chips ?? 0;
}

function playerBySeat(ctx: HandCommitContext, seatIndex: number) {
  const playerId = ctx.state.seatToPlayer.get(seatIndex);
  if (playerId === undefined) return undefined;
  return ctx.state.players.get(playerId);
}

/** 结算摘要：各 Pot 金额/赢家/是否比牌（查询投影用；不含未公开底牌，03 §5.5）。 */
function buildSummary(outcome: NonNullable<TournamentState["hand"]>["outcome"]): unknown {
  // 赢家取 Engine 结算结果 outcome.awards（winners/prizeBySeat），而非 eligiblePlayers（只是可参赛者）。
  const awardByPot = new Map<number, PotAward>();
  for (const award of outcome?.awards ?? []) awardByPot.set(award.potIndex, award);
  return {
    showdown: outcome?.showdown ?? false,
    pots: (outcome?.pots ?? []).map((pot) => {
      const award = awardByPot.get(pot.index);
      return {
        potIndex: pot.index,
        amount: pot.amount,
        winners: award?.winners ?? [],
      };
    }),
    winners: outcome?.winners ?? [],
  };
}

/** Event payload 剥离内部 0 基 sequence（DB 列承载权威 sequence，避免双份语义）。 */
function stripSequence(event: PokerEvent): unknown {
  const { sequence: _sequence, ...rest } = event as PokerEvent & { sequence: number };
  void _sequence;
  return rest;
}
