/**
 * TournamentEngine（TEX-15）。
 *
 * 纯领域锦标赛编排：初始筹码、首手/后续 Hand、Blind Level、Dealer 轮转、淘汰、排名、Heads-Up 切换、
 * 唯一 Champion 与锦标赛事件。PokerHandEngine 负责单手规则；本引擎只通过其公开接口驱动每手，
 * 不复制或重写下注、发牌、结算、Side Pot 等逻辑（§6.14）。
 *
 * 确定性：除首手 Dealer 抽签与洗牌（经注入 RNG / 注入 Deck）外，所有状态转移为确定性纯转移（§16）。
 * 非法指令（重复撤回、错误状态、非对应动作等）抛错且不改变状态、事件日志或 sequence。
 *
 * 权威规格：docs/01-engine-spec.md §12、§13、§14、§16、§17。
 */
import type { Deck, RandomSource } from "../cards";
import { selectDealer } from "../rules/blinds";
import {
  computeBlindLevelIndex,
  nextTournamentDealer,
  resolveBlindLevel,
  sortEliminationGroup,
  validateTournamentConfig,
} from "../rules/tournament";
import { PokerHandEngine } from "./hand-engine";
import { assertTournamentInvariants } from "./tournament-invariants";
import type { HandConfig, SeatConfig } from "../model/hand";
import type { LegalActions } from "../model/legal";
import type { PlayerAction } from "../model/action";
import type { ParticipantKind } from "../model/type";
import type {
  EliminationGroup,
  FinalStanding,
  PlacementRange,
  PlayerTournamentStatus,
  TournamentConfig,
  TournamentConfigInput,
  TournamentParticipantConfig,
  TournamentParticipantState,
  TournamentState,
} from "../model/tournament";
import type { PokerEvent } from "../events/events";

/** 引擎内部可变参赛者副本（最终冻结为 TournamentParticipantState 对外）。 */
interface MutableParticipant {
  readonly seatIndex: number;
  readonly name: string;
  readonly kind: ParticipantKind;
  status: PlayerTournamentStatus;
  chips: number;
  readonly startingStack: number;
  finish?: { placementRange: PlacementRange; displayOrder: number };
}

/** 构造选项：可注入首手 Dealer 与每手牌堆（供测试确定性）。 */
export interface TournamentEngineOptions {
  /** 首手 Dealer（缺省由 rng 从 ACTIVE、chips>0、非撤回座位中选）。 */
  readonly firstDealerSeat?: number;
  /** 每手牌堆提供者（`handNumber` 从 1 起）；返回 undefined 时该手用 52 张标准牌堆按 rng 洗（注：测试应提供以达确定性）。 */
  readonly deckForHand?: (handNumber: number) => Deck | undefined;
}

export class TournamentEngine {
  private readonly config: TournamentConfig;
  private readonly rng: RandomSource;
  private readonly deckForHand: (handNumber: number) => Deck | undefined;
  private participants: MutableParticipant[] = [];
  private phase: "running" | "finished" = "running";
  private handNumber = 0;
  private handInProgress = false;
  private blindLevel = 0;
  private smallBlind: number;
  private bigBlind: number;
  private dealerSeat: number | null = null;
  private forfeitedChips = 0;
  private readonly initialTotalChips: number;
  private champion: number | null = null;
  private eliminations: EliminationGroup[] = [];
  private finalStandings: FinalStanding[] = [];
  private elapsedSeconds = 0;
  private pokerHand: PokerHandEngine | null = null;
  private handEventsAbsorbed = 0;
  private readonly events: PokerEvent[] = [];
  private nextSequence = 0;
  private handStartChips = new Map<number, number>();

  constructor(
    config: TournamentConfigInput,
    rng: RandomSource,
    participants: readonly TournamentParticipantConfig[],
    opts: TournamentEngineOptions = {},
  ) {
    this.config = validateTournamentConfig(config);
    this.rng = rng;
    this.deckForHand = opts.deckForHand ?? (() => undefined);

    if (participants.length < 2 || participants.length > this.config.maxPlayers) {
      throw new Error(
        `TournamentEngine: 参赛者须 2–${this.config.maxPlayers}，实际 ${participants.length}`,
      );
    }
    const seen = new Set<number>();
    for (const p of participants) {
      if (!Number.isInteger(p.seatIndex) || p.seatIndex < 0) {
        throw new Error(`TournamentEngine: 座位号必须为非负整数，收到 ${p.seatIndex}`);
      }
      if (seen.has(p.seatIndex)) throw new Error(`TournamentEngine: 座位号 ${p.seatIndex} 重复`);
      seen.add(p.seatIndex);
      this.participants.push({
        seatIndex: p.seatIndex,
        name: p.name,
        kind: p.kind,
        status: "ACTIVE",
        chips: this.config.startingStack,
        startingStack: this.config.startingStack,
      });
    }
    this.initialTotalChips = this.participants.reduce((sum, p) => sum + p.chips, 0);
    this.smallBlind = this.config.smallBlind;
    this.bigBlind = this.config.bigBlind;

    const eligible = this.participants
      .filter((p) => p.chips > 0)
      .map((p) => ({ seatIndex: p.seatIndex, name: p.name, kind: p.kind, chips: p.chips }));
    this.dealerSeat = selectDealer(eligible, rng, opts.firstDealerSeat);
  }

  /** 启动下一手；已完结或已有进行中的手则抛错。返回当前行动者 LegalActions 或 null（手/锦标赛结束）。 */
  startNextHand(): LegalActions | null {
    if (this.phase === "finished") throw new Error("startNextHand: 锦标赛已结束");
    if (this.handInProgress) throw new Error("startNextHand: 已有一手进行中");
    this.resolvePendingWithdrawals(); // 安全结算点：先把 EXIT_PENDING 落为 WITHDRAWN

    const active = this.participants.filter((p) => p.status === "ACTIVE");
    if (active.length < 2) throw new Error("startNextHand: ACTIVE 玩家不足 2");
    if (active.some((p) => p.chips <= 0)) throw new Error("startNextHand: 存在非正筹码的 ACTIVE 玩家");

    if (this.handNumber > 0) {
      this.dealerSeat = nextTournamentDealer(this.dealerSeat!, active.map((p) => p.seatIndex));
    }

    const handNumber = this.handNumber + 1;
    const levelIdx = computeBlindLevelIndex(
      this.config.blindMode,
      this.config.blindStructure,
      handNumber,
      this.elapsedSeconds,
    );
    const blinds = resolveBlindLevel(this.config.blindStructure, levelIdx);
    this.handStartChips = new Map(active.map((p) => [p.seatIndex, p.chips]));

    const seats: SeatConfig[] = active.map((p) => ({
      seatIndex: p.seatIndex,
      name: p.name,
      kind: p.kind,
      chips: p.chips,
    }));
    const deck = this.deckForHand(handNumber);
    const handConfig: HandConfig = {
      handNumber,
      seats,
      smallBlind: blinds.smallBlind,
      bigBlind: blinds.bigBlind,
      rng: this.rng,
      dealerSeat: this.dealerSeat!,
      ...(deck ? { deck } : {}),
    };

    this.handNumber = handNumber;
    this.blindLevel = levelIdx;
    this.smallBlind = blinds.smallBlind;
    this.bigBlind = blinds.bigBlind;
    this.pokerHand = new PokerHandEngine(handConfig);
    this.handEventsAbsorbed = 0;
    this.handInProgress = true;
    this.absorbHandEvents();

    if (this.pokerHand.isComplete()) {
      this.processHandOutcome();
    }
    this.assertInvariants();
    if (this.isFinished()) return null;
    if (this.pokerHand.isComplete()) return null;
    return this.pokerHand.getLegalActions();
  }

  /** 校验并应用一个下注 Action；非法则抛错且状态/事件/sequence 不变。 */
  applyAction(action: PlayerAction): LegalActions | null {
    if (!this.handInProgress || !this.pokerHand) throw new Error("applyAction: 当前无进行中的手");
    this.pokerHand.applyAction(action); // 非法抛错，不改动状态
    this.absorbHandEvents();
    if (this.pokerHand.isComplete()) this.processHandOutcome();
    this.assertInvariants();
    if (this.isFinished()) return null;
    if (this.pokerHand.isComplete()) return null;
    return this.pokerHand.getLegalActions();
  }

  /** 撤回参与者（Tournament 级指令，非下注 Action，不占 currentActor）。 */
  withdrawParticipant(seatIndex: number): void {
    if (this.phase === "finished") throw new Error("withdrawParticipant: 锦标赛已结束");
    const p = this.participants.find((pp) => pp.seatIndex === seatIndex);
    if (!p) throw new Error(`withdrawParticipant: 无参赛者 ${seatIndex}`);
    if (p.status !== "ACTIVE") {
      throw new Error(`withdrawParticipant: 参与者 ${seatIndex} 状态 ${p.status} 不可撤回`);
    }
    p.status = "EXIT_PENDING";

    if (this.handInProgress && this.pokerHand) {
      const seatInHand = this.pokerHand.getState().seats.find((s) => s.seatIndex === seatIndex);
      // 未 all-in 且仍可行动者：立即按弃权折叠。
      if (seatInHand && !seatInHand.isAllIn && !seatInHand.folded) {
        this.pokerHand.foldForWithdraw(seatIndex);
        this.absorbHandEvents();
        if (this.pokerHand.isComplete()) this.processHandOutcome();
      }
      // 已全下或已弃牌：等待 Hand 结束在安全结算点转为 WITHDRAWN。
    } else {
      this.finalizeWithdrawal(seatIndex); // 手间为安全结算点，立即落为 WITHDRAWN。
      this.maybeFinish();
    }
    this.assertInvariants();
  }

  /** 当前行动者合法动作集合。 */
  getLegalActions(): LegalActions {
    if (!this.handInProgress || !this.pokerHand) throw new Error("getLegalActions: 当前无进行中的手");
    return this.pokerHand.getLegalActions();
  }

  /** 锦标赛权威状态。 */
  getState(): TournamentState {
    return Object.freeze({
      config: this.config,
      phase: this.phase,
      handNumber: this.handNumber,
      handInProgress: this.handInProgress,
      blindLevel: this.blindLevel,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      dealerSeat: this.dealerSeat,
      participants: Object.freeze(this.participants.map(snapshotParticipant)),
      forfeitedChips: this.forfeitedChips,
      initialTotalChips: this.initialTotalChips,
      champion: this.champion,
      eliminations: Object.freeze(
        this.eliminations.map((g) =>
          Object.freeze({
            handNumber: g.handNumber,
            placementRange: Object.freeze({ ...g.placementRange }),
            players: Object.freeze([...g.players]),
          }),
        ),
      ),
      finalStandings: Object.freeze(
        this.finalStandings.map((fs) =>
          Object.freeze({ ...fs, placementRange: Object.freeze({ ...fs.placementRange }) }),
        ),
      ),
      elapsedSeconds: this.elapsedSeconds,
      nextSequence: this.nextSequence,
      hand: this.pokerHand ? this.pokerHand.getState() : null,
    });
  }

  /** 主事件流（内部权威流；含手级与锦标赛级事件，sequence 单调）。 */
  getEvents(): readonly PokerEvent[] {
    return Object.freeze([...this.events]);
  }

  /** 上报累计经过秒数（time 模式；game-server 在 Hand 间调用，等级在下一手启动时生效）。 */
  recordElapsedTime(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 0) {
      throw new Error("recordElapsedTime: 需非负整数秒");
    }
    this.elapsedSeconds += seconds;
    this.assertInvariants();
  }

  /** 淘汰/撤回/冠军处理，把完成的 Hand 结果写回锦标赛状态（§12 / §13）。 */
  private processHandOutcome(): void {
    const handState = this.pokerHand!.getState();
    for (const seat of handState.seats) {
      const p = this.participants.find((pp) => pp.seatIndex === seat.seatIndex);
      if (p) p.chips = seat.chips;
    }

    // 先落 WITHDRAWN（不计排名资格），再算淘汰组，避免撤回者抬升名次场．
    this.resolvePendingWithdrawals();
    const activeNow = this.participants.filter((p) => p.status === "ACTIVE").length;
    const toEliminate = this.participants.filter((p) => p.status === "ACTIVE" && p.chips === 0);
    if (toEliminate.length > 0) {
      const groupSize = toEliminate.length;
      const activeAfterElim = activeNow - groupSize;
      const range: PlacementRange = { from: activeAfterElim + 1, to: activeAfterElim + groupSize };
      const sortedSeats = sortEliminationGroup(
        toEliminate.map((p) => ({
          seatIndex: p.seatIndex,
          handStartChips: this.handStartChips.get(p.seatIndex) ?? p.startingStack,
        })),
      );
      const sorted = sortedSeats.map((s) => this.participants.find((pp) => pp.seatIndex === s)!);
      this.eliminations.push({
        handNumber: this.handNumber,
        placementRange: range,
        players: Object.freeze(sorted.map((p) => p.seatIndex)),
      });
      sorted.forEach((p, i) => {
        p.status = "ELIMINATED";
        p.finish = { placementRange: range, displayOrder: i + 1 };
        this.emit({
          type: "PLAYER_ELIMINATED",
          handNumber: this.handNumber,
          seatIndex: p.seatIndex,
          placementRange: range,
          displayOrder: i + 1,
        });
      });
    }

    this.handInProgress = false;
    this.maybeFinish();
  }

  /** EXIT_PENDING → WITHDRAWN：未投入剩余筹码记入 forfeitedChips。 */
  private finalizeWithdrawal(seatIndex: number): void {
    const p = this.participants.find((pp) => pp.seatIndex === seatIndex)!;
    if (p.status !== "EXIT_PENDING") return;
    const forfeited = p.chips;
    p.chips = 0;
    this.forfeitedChips += forfeited;
    p.status = "WITHDRAWN";
    this.emit({ type: "PLAYER_WITHDRAWN", seatIndex, forfeitedChips: forfeited });
  }

  /** 手间/结算点将所有 EXIT_PENDING 落为 WITHDRAWN。 */
  private resolvePendingWithdrawals(): void {
    for (const p of this.participants) {
      if (p.status === "EXIT_PENDING") this.finalizeWithdrawal(p.seatIndex);
    }
  }

  /** 冠军 / 完结判定（仅剩一位 ACTIVE）。 */
  private maybeFinish(): void {
    if (this.phase === "finished") return;
    const active = this.participants.filter((p) => p.status === "ACTIVE");
    if (active.length === 1) {
      const champ = active[0]!;
      this.champion = champ.seatIndex;
      champ.finish = { placementRange: { from: 1, to: 1 }, displayOrder: 1 };
      this.phase = "finished";
      this.finalStandings = this.buildFinalStandings();
      this.emit({
        type: "TOURNAMENT_FINISHED",
        championSeat: champ.seatIndex,
        finalStandings: Object.freeze([...this.finalStandings]),
      });
    } else if (active.length === 0) {
      this.phase = "finished";
      this.champion = null;
      this.finalStandings = this.buildFinalStandings();
      this.emit({
        type: "TOURNAMENT_FINISHED",
        championSeat: null,
        finalStandings: Object.freeze([...this.finalStandings]),
      });
    }
  }

  private buildFinalStandings(): FinalStanding[] {
    return this.participants
      .filter((p) => p.finish)
      .map((p) => ({
        seatIndex: p.seatIndex,
        name: p.name,
        placementRange: p.finish!.placementRange,
        displayOrder: p.finish!.displayOrder,
      }))
      .sort((a, b) => a.placementRange.from - b.placementRange.from || a.displayOrder - b.displayOrder);
  }

  private isFinished(): boolean {
    return this.phase === "finished";
  }

  private absorbHandEvents(): void {
    if (!this.pokerHand) return;
    const all = this.pokerHand.getEvents();
    for (let i = this.handEventsAbsorbed; i < all.length; i++) {
      const e = all[i]!;
      this.events.push(Object.freeze({ ...e, sequence: this.nextSequence++ }) as unknown as PokerEvent);
    }
    this.handEventsAbsorbed = all.length;
  }

  private emit<T extends Omit<PokerEvent, "sequence">>(event: T): void {
    this.events.push(deepFreeze({ ...event, sequence: this.nextSequence++ }) as unknown as PokerEvent);
  }

  private assertInvariants(): void {
    assertTournamentInvariants(this.getState());
  }
}

/** 递归冻结对象/数组，确保事件快照的嵌套字段（placementRange、finalStandings 等）同样不可变（§14）。 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key], seen);
    }
  }
  return value;
}

function snapshotParticipant(p: MutableParticipant): TournamentParticipantState {
  const base = {
    seatIndex: p.seatIndex,
    name: p.name,
    kind: p.kind,
    status: p.status,
    chips: p.chips,
    startingStack: p.startingStack,
  };
  return p.finish
    ? Object.freeze({ ...base, finish: Object.freeze({ ...p.finish }) })
    : Object.freeze(base);
}
