export function dealFlightOrigin(
  table: { readonly left: number; readonly top: number },
  deck: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
): { readonly x: number; readonly y: number } {
  return {
    x: deck.left + deck.width / 2 - table.left,
    y: deck.top + deck.height / 2 - table.top,
  };
}

/**
 * Presentation-only geometry for a card travelling from the visible table deck
 * to a seat's hand area. It contains no card, rule, or projection data.
 */
export function dealFlightVector(
  table: { readonly width: number; readonly height: number },
  target: { readonly left: string; readonly top: string },
  origin: { readonly x: number; readonly y: number },
  cardIndex: 0 | 1,
  targetVariant: "seat" | "hole",
): { readonly x: number; readonly y: number; readonly midX: number; readonly midY: number } {
  const cardOffset = targetVariant === "hole"
    ? Math.min(22, Math.max(14, table.width * 0.018))
    : Math.min(14, Math.max(9, table.width * 0.011));
  const targetX = table.width * (Number.parseFloat(target.left) / 100) + (cardIndex === 0 ? -cardOffset : cardOffset);
  // The hand row is above the player name/chips card at the seat coordinate.
  const targetY = table.height * ((Number.parseFloat(target.top) - 6) / 100);
  const x = targetX - origin.x;
  const y = targetY - origin.y;
  // The Windows Solitaire reference keeps cards upright and follows a clean,
  // shallow arc. Only transform/opacity are animated by the caller.
  const lift = Math.min(46, Math.max(20, Math.hypot(x, y) * 0.06));
  return { x, y, midX: x * 0.58, midY: y * 0.58 - lift };
}

/** A different key forces the browser to start a fresh CSS flight per Event. */
export function dealFlightKey(handId: string | null, playerId: string, cardIndex: 0 | 1): string {
  return `${handId ?? "no-hand"}:${playerId}:${cardIndex}`;
}
