/**
 * 核心领域枚举与字面量类型（TEX-14）。
 *
 * 本模块为**叶子类型模块**：只含纯类型/枚举，零运行时依赖，供 rules / pots / events /
 * engine 共同引用，从而打破「engine ↔ rules」的循环依赖。
 *
 * 权威规格：docs/01-engine-spec.md §4（状态域）、§5.1（动作）、§12（参与者种类）。
 */

/** 下注街（每条街按本手当前 BB 重算最小下注/完整加注基准，见 §8.2）。 */
export const STREETS = ["preflop", "flop", "turn", "river"] as const;
export type Street = (typeof STREETS)[number];

/**
 * 一手牌的阶段。下注进行时 `phase === street`；结算完成后为 "hand_end"。
 * 比牌（SHOWDOWN）与 P0T_SETTLEMENT 是 settle() 内的**原子**转移：在一次状态转移中同步完成
 * 揭示与分池结算并落到 "hand_end"，不暴露独立的可观测 "showdown" 相态，故不单列。
 * 权威规格 §6（HAND_START→…→POT_SETTLEMENT→HAND_END）。
 */
export type HandPhase = Street | "hand_end";

/** 参与者种类：P0 不启用 BOT，但从第一天建模（《总规划》§6）。 */
export const PARTICIPANT_KINDS = ["human", "bot"] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

/** 动作来源。P0 只启用 `human_socket` 与 `system_timer`（§5.1；《总规划》§6）。 */
export const ACTION_SOURCES = ["human_socket", "bot_controller", "system_timer"] as const;
export type ActionSource = (typeof ACTION_SOURCES)[number];

/** 动作类型（§5.1 / §8.1）。 */
export const ACTION_TYPES = ["fold", "check", "call", "bet", "raise", "all-in"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
