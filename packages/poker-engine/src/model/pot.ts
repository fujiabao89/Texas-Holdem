/**
 * 底池与结算结果（TEX-14 手级）。
 *
 * `contributors`（含 Fold 玩家，计入金额）与 `eligiblePlayers`（未 Fold 且贡献≥该层，可获奖）分离：
 * Fold 玩家保留筹码但永远不入 eligible（§9）。
 *
 * 权威规格：docs/01-engine-spec.md §9、§17。
 */

/** 一个 Pot（主池或边池）。金额为整数且 ≥0；结算后 contributors≥2、eligible≥1。 */
export interface Pot {
  /** 0 为主池，>0 为边池（自低层起编号）。 */
  readonly index: number;
  readonly amount: number;
  /** 贡献≥本层且计入金额的座位号（含 Fold）。 */
  readonly contributors: readonly number[];
  /** 未 Fold 且贡献≥本层、可参与比牌的座位号。 */
  readonly eligiblePlayers: readonly number[];
}

/** 每个 Pot 的分配结果。`prizeBySeat` 之和恒等于 `totalAmount`。 */
export interface PotAward {
  readonly potIndex: number;
  readonly totalAmount: number;
  /** 受奖赢家（平局可多个）。 */
  readonly winners: readonly number[];
  /** 每个座位实际分到的筹码。 */
  readonly prizeBySeat: Readonly<Record<number, number>>;
  readonly eligiblePlayers: readonly number[];
}
