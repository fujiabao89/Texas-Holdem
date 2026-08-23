/**
 * 锦标赛领域类型（TEX-15）。
 *
 * 本模块为**叶子类型模块**：只含纯类型/枚举常量，供 rules / engine / events 引用，
 * 打破循环依赖。金额均为非负整数；盲注、初始筹码、等级为受限正整数（§12）。
 *
 * 权威规格：docs/01-engine-spec.md §12（配置与淘汰/排名）、§13（退出/撤回）、§17（不变量）。
 */
import type { GameState } from "./hand";
import type { ParticipantKind, ActionSource } from "./type";
import type { ActionTime, TimeBankSeconds } from "../timer/action-timer";

/** 盲注推进模式：固定 / 按时间 / 按手数（§12；《总规划》§2.3）。 */
export const BLIND_MODES = ["fixed", "time", "hands"] as const;
export type BlindMode = (typeof BLIND_MODES)[number];

/** 单个盲注等级。每级独立校验（SB<BB），可较上一级下降；`hands`/`durationSeconds` 只在对应模式有意义。 */
export interface BlindLevel {
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** `hands` 模式下本等级持续手数（正整数）。 */
  readonly hands?: number;
  /** `time` 模式下本等级持续秒数（正整数）。 */
  readonly durationSeconds?: number;
}

/** 名次范围（`from` 为更好的名次、数值更小；同手淘汰共享）。 */
export interface PlacementRange {
  readonly from: number;
  readonly to: number;
}

/**
 * 锦标赛配置。
 * - `actionTime` 缺省 30 秒；`timeBank` 缺省 60 秒；`UNLIMITED` 时必须 `timeBank = 0`。
 * - `blindStructure` 为等级序列；首级须与 `smallBlind`/`bigBlind` 一致，等级独立校验、允许下降。
 */
export interface TournamentConfig {
  readonly maxPlayers: number;
  readonly startingStack: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly blindMode: BlindMode;
  readonly blindStructure: readonly BlindLevel[];
  readonly actionTime: ActionTime;
  readonly timeBank: TimeBankSeconds;
}

/** 配置输入：`actionTime`/`timeBank` 可为空由校验补缺省值（§12）。 */
export type TournamentConfigInput = Omit<TournamentConfig, "actionTime" | "timeBank"> & {
  readonly actionTime?: ActionTime;
  readonly timeBank?: TimeBankSeconds;
};

/** 参赛者在锦标赛内的状态（§12 / §13）。 */
export const PLAYER_TOURNAMENT_STATUSES = ["ACTIVE", "EXIT_PENDING", "WITHDRAWN", "ELIMINATED"] as const;
export type PlayerTournamentStatus = (typeof PLAYER_TOURNAMENT_STATUSES)[number];

/** 参赛者配置（开局输入）。 */
export interface TournamentParticipantConfig {
  readonly seatIndex: number;
  readonly name: string;
  readonly kind: ParticipantKind;
}

/** 参赛者在锦标赛内的持久状态。 */
export interface TournamentParticipantState {
  readonly seatIndex: number;
  readonly name: string;
  readonly kind: ParticipantKind;
  readonly status: PlayerTournamentStatus;
  readonly chips: number;
  readonly startingStack: number;
  /** 达成终局名次（ELIMINATED 或 Champion）时填充；含 placementRange 与 displayOrder（§12）。 */
  readonly finish?: { readonly placementRange: PlacementRange; readonly displayOrder: number };
}

/** 同手淘汰分组：同手淘汰者共享同一 `placementRange`，`players` 按稳定规则排序（§12）。 */
export interface EliminationGroup {
  readonly handNumber: number;
  readonly placementRange: PlacementRange;
  /** 座位号，按（手开始 stack 降序 → seatIndex 升序）稳定排序。 */
  readonly players: readonly number[];
}

/** 终局最终名次（Champion 与全部淘汰者）。 */
export interface FinalStanding {
  readonly seatIndex: number;
  readonly name: string;
  readonly placementRange: PlacementRange;
  readonly displayOrder: number;
}

export const TOURNAMENT_PHASES = ["running", "finished"] as const;
export type TournamentPhase = (typeof TOURNAMENT_PHASES)[number];

/** 锦标赛权威状态（服务器内部）。`hand` 为进行中/最近一手的手级权威状态，无手为 null。 */
export interface TournamentState {
  readonly config: TournamentConfig;
  readonly phase: TournamentPhase;
  /** 当前/最近一手的手号（0 表示尚未开局）。 */
  readonly handNumber: number;
  readonly handInProgress: boolean;
  /** 当前盲注等级（0-based 索引到 `blindStructure`）。 */
  readonly blindLevel: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** 下一手/本手 Dealer；尚未开局且未选时 null。 */
  readonly dealerSeat: number | null;
  readonly participants: readonly TournamentParticipantState[];
  readonly forfeitedChips: number;
  readonly initialTotalChips: number;
  readonly champion: number | null;
  readonly eliminations: readonly EliminationGroup[];
  readonly finalStandings: readonly FinalStanding[];
  /** 累计经过秒数（time 模式；game-server 上报）。 */
  readonly elapsedSeconds: number;
  /** 主事件流下一个 `sequence`（非法指令后不变）。 */
  readonly nextSequence: number;
  /** 进行中/最近一手的手级权威状态（含底牌、牌堆、burn）；无手为 null。 */
  readonly hand: GameState | null;
}

/** 锦标赛级指令（§13）：`WithdrawParticipant` 是独立指令，非下注 Action，不占 currentActor。 */
export type TournamentCommand =
  | { readonly type: "withdrawParticipant"; readonly seatIndex: number; readonly source: ActionSource };
