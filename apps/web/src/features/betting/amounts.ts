import type { GameSnapshot, LegalActions } from "@texas-holdem/protocol";

export type WagerKind = "BET" | "RAISE";

export interface WagerRange {
  readonly kind: WagerKind;
  readonly min: number;
  readonly max: number;
}

export interface QuickAmount {
  readonly label: "2BB" | "2.5BB" | "3BB" | "4BB" | "1/3 Pot" | "1/2 Pot" | "2/3 Pot" | "Pot";
  readonly amount: number;
}

/**
 * The only client calculation in this feature is a presentation suggestion.
 * Its range always comes from LegalActions and the selected value is still
 * submitted to the server for authoritative validation.
 */
export function wagerRange(legal: LegalActions): WagerRange | null {
  if (legal.canBet && legal.minBetTo !== null) return { kind: "BET", min: legal.minBetTo, max: legal.maxRaiseTo };
  if (legal.canRaise && legal.minRaiseTo !== null) return { kind: "RAISE", min: legal.minRaiseTo, max: legal.maxRaiseTo };
  return null;
}

export function wagerStep(bigBlind: number): number {
  return Math.max(1, Math.round(bigBlind / 10));
}

export function clampWager(value: number, range: WagerRange): number {
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

export function quickAmounts(snapshot: GameSnapshot, range: WagerRange): readonly QuickAmount[] {
  const pot = snapshot.pots.reduce((total, item) => total + item.amount, 0);
  const actor = snapshot.players.find((player) => player.playerId === snapshot.viewer.playerId);
  if (actor === undefined) return [];
  const raw = snapshot.handPhase === "PREFLOP"
    ? ([
      ["2BB", snapshot.blindLevel.bigBlind * 2],
      ["2.5BB", snapshot.blindLevel.bigBlind * 2.5],
      ["3BB", snapshot.blindLevel.bigBlind * 3],
      ["4BB", snapshot.blindLevel.bigBlind * 4],
    ] as const)
    : ([
      ["1/3 Pot", 1 / 3],
      ["1/2 Pot", 1 / 2],
      ["2/3 Pot", 2 / 3],
      ["Pot", 1],
    ] as const).map(([label, fraction]) => [
      label,
      range.kind === "BET"
        ? fraction * pot
        : actor.streetBet + snapshot.viewer.legalActions!.callAmount + fraction * (pot + snapshot.viewer.legalActions!.callAmount),
    ] as const);
  const step = wagerStep(snapshot.blindLevel.bigBlind);
  const seen = new Set<number>();
  return raw.flatMap(([label, candidate]) => {
    const rounded = Math.round(candidate / step) * step;
    const amount = clampWager(rounded, range);
    if (seen.has(amount)) return [];
    seen.add(amount);
    return [{ label, amount }];
  });
}
