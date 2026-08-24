/**
 * 单局配置、内存状态与结果（TEX-14）。
 *
 * GameState 为服务端内部权威状态（含 deck 顺序、burn 牌面、全部底牌）；客户端/AI 一律经
 * game-server 投影取数（§2.2 / §5.3）。金额均为非负整数（§4.3 / §8.6）。
 *
 * 权威规格：docs/01-engine-spec.md §4、§5.1、§16（确定性：随机入口已写入 state）。
 */
import type { Card, Deck, RandomSource } from "../cards";
import type { HandPhase, ParticipantKind, Street } from "./type";
import type { PlayerState } from "./player";
import type { Pot, PotAward } from "./pot";

/** 参与一手的座位配置（调用方/锦标赛层传入；本手不处理淘汰/撤回）。 */
export interface SeatConfig {
  readonly seatIndex: number;
  readonly name: string;
  readonly kind: ParticipantKind;
  /** 本手初始筹码。 */
  readonly chips: number;
}

/**
 * 单局配置。
 * - `dealerSeat` 缺省时由 `rng` 从 `chips>0` 的座位中选（结果写入 state，§16）。
 * - `deck` 缺省 = 标准 52 张 + `shuffle(rng)`（洗牌顺序写入 state）；测试可注入预排 `Deck` 精确控牌。
 *   注入契约：必须为**恰好 52 张唯一牌**（与 §17 牌堆守恒不变量一致），拒绝部分前缀。
 */
export interface HandConfig {
  readonly handNumber: number;
  readonly seats: readonly SeatConfig[];
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly rng: RandomSource;
  readonly dealerSeat?: number;
  readonly deck?: Deck;
}

export interface GameState {
  readonly handNumber: number;
  /** 下注进行时 `phase === street`；结算完成后为 "hand_end"（比牌/分池为 settle() 内原子转移，不暴露独立 showdown 相态）。 */
  readonly phase: HandPhase;
  readonly street: Street;
  readonly seats: readonly PlayerState[];
  /** 公共牌（0 / 3 / 4 / 5 张）。 */
  readonly communityCards: readonly Card[];
  /** 燃牌（仅服务器内部；永不进入事件或客户端视图）。 */
  readonly burnCards: readonly Card[];
  /** 剩余待发牌（已发底牌+公共牌+burn 与 remainingDeck 构成 52 张无重叠分区，§17）。 */
  readonly remainingDeck: readonly Card[];
  readonly dealerSeat: number;
  readonly sbSeat: number;
  readonly bbSeat: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** 当前待行动者；非下注阶段为 null。 */
  readonly currentActor: number | null;
  /** 本街最高总投入（preflop 初始为 BB，postflop 为 0）。 */
  readonly currentBet: number;
  readonly lastFullRaiseSize: number;
  /** 本街是否已出现首笔完整 Bet/Raise（决定 minRaiseTo 是否回落到 BB）。 */
  readonly hasFullBetOrRaise: boolean;
  /** 结算时填充；下注期间为空。 */
  readonly pots: readonly Pot[];
  readonly nextSequence: number;
  /** 本手初始总筹码（筹码守恒断言用，§17）。 */
  readonly initialTotalChips: number;
  readonly outcome: HandOutcome | null;
}

/** 单局结算结果。 */
export interface HandOutcome {
  readonly handNumber: number;
  /** 终局公共牌（比牌/自动补牌后为 5 张；全员弃牌时可为 0/3/4）。 */
  readonly board: readonly Card[];
  readonly pots: readonly Pot[];
  readonly awards: readonly PotAward[];
  readonly uncalledReturns: readonly { readonly seatIndex: number; readonly amount: number }[];
  /** 结算后至少赢下一池、且未弃牌的座位号（全员弃牌则为唯一剩余玩家）。 */
  readonly winners: readonly number[];
  /** 是否发生比牌（false = 其余玩家均弃牌，直接判给最后剩余者）。 */
  readonly showdown: boolean;
}
