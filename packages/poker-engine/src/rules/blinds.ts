/**
 * Dealer / 盲注 / 行动顺序（TEX-14）。
 *
 * 首手 Dealer 用服务器随机源从 `chips>0` 的座位中选（§11 / §16，结果写入 state）；后续 Dealer 轮转
 * 属锦标赛层（TEX-15）。盲注与行动计算基于 Seat 顺时针（§11）。
 *
 * 权威规格：docs/01-engine-spec.md §11。
 */
import type { RandomSource } from "../cards";
import type { SeatConfig } from "../model/hand";
import type { Street } from "../model/type";

/** 座位号集合按「从某座位左侧起顺时针」顺序返回（可绕桌，包含该起始座位及其后）。 */
export function seatsClockwise(seatIndices: readonly number[], afterSeat: number): number[] {
  const sorted = [...seatIndices].sort((a, b) => a - b);
  const idx = sorted.findIndex((s) => s > afterSeat);
  const start = idx === -1 ? 0 : idx;
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i++) out.push(sorted[(start + i) % sorted.length]!);
  return out;
}

/** 选 Dealer：`dealerSeat` 已指定则用之；否则用 rng 从 `chips>0` 座位随机选。 */
export function selectDealer(
  seats: readonly SeatConfig[],
  rng: RandomSource,
  dealerSeat?: number,
): number {
  if (dealerSeat !== undefined) return dealerSeat;
  const eligible = seats.filter((s) => s.chips > 0).map((s) => s.seatIndex);
  if (eligible.length === 0) throw new Error("selectDealer: 无任何持筹码的座位可选 Dealer");
  const pick = rng.nextInt(eligible.length);
  return eligible[pick]!;
}

export interface Blinds {
  readonly sbSeat: number;
  readonly bbSeat: number;
}

/** 计算 SB / BB（≥3 人：Dealer 左=SB、再左=BB；Heads-Up：Dealer 兼 SB）。 */
export function computeBlinds(seats: readonly SeatConfig[], dealerSeat: number): Blinds {
  const indices = seats.map((s) => s.seatIndex);
  if (indices.length === 2) {
    const other = indices.find((s) => s !== dealerSeat)!;
    return { sbSeat: dealerSeat, bbSeat: other };
  }
  const afterDealer = seatsClockwise(indices, dealerSeat);
  return { sbSeat: afterDealer[0]!, bbSeat: afterDealer[1]! };
}

/** 首行动者（§11）：Pre-Flop 多人=BB 左首、HU=Button/SB；Post-Flop 多人=Dealer 左首、HU=BB。 */
export function firstActor(
  seats: readonly SeatConfig[],
  dealerSeat: number,
  street: Street,
): number {
  const indices = seats.map((s) => s.seatIndex);
  if (indices.length === 2) {
    return street === "preflop" ? dealerSeat : computeBlinds(seats, dealerSeat).bbSeat;
  }
  const { bbSeat } = computeBlinds(seats, dealerSeat);
  return street === "preflop"
    ? seatsClockwise(indices, bbSeat)[0]!
    : seatsClockwise(indices, dealerSeat)[0]!;
}

/** 下一个可行动座位：从 `afterSeat` 左侧起顺时针，取第一个满足 `canAct` 的座位；无则 null。 */
export function nextActionableSeat(
  seatIndices: readonly number[],
  afterSeat: number,
  canAct: (seat: number) => boolean,
): number | null {
  const ordered = seatsClockwise(seatIndices, afterSeat);
  for (const seat of ordered) if (canAct(seat)) return seat;
  return null;
}
