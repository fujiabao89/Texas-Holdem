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
): { readonly x: number; readonly y: number; readonly midX: number; readonly midY: number } {
  const targetX = table.width * (Number.parseFloat(target.left) / 100);
  // The hand row is above the player name/chips card at the seat coordinate.
  const targetY = table.height * ((Number.parseFloat(target.top) - 6) / 100);
  const x = targetX - origin.x;
  const y = targetY - origin.y;
  // Lift the card mid-flight. This gives even a short journey to the bottom
  // seat a clearly readable dealer "throw". A lateral sway keeps heads-up
  // flights visibly curved instead of looking like a vertical snap.
  const lift = Math.min(82, Math.max(44, Math.hypot(x, y) * 0.14));
  const sway = Math.min(58, Math.max(34, Math.hypot(x, y) * 0.1));
  return { x, y, midX: x * 0.46 + (x < 0 ? -sway : sway), midY: y * 0.46 - lift };
}

/** A different key forces the browser to start a fresh CSS flight per Event. */
export function dealFlightKey(handId: string | null, playerId: string, cardIndex: 0 | 1): string {
  return `${handId ?? "no-hand"}:${playerId}:${cardIndex}`;
}
