/**
 * Presentation-only geometry for a card travelling from the visible table deck
 * to a seat's hand area. It contains no card, rule, or projection data.
 */
export function dealFlightVector(
  table: { readonly width: number; readonly height: number },
  target: { readonly left: string; readonly top: string },
): { readonly x: number; readonly y: number; readonly midX: number; readonly midY: number } {
  const targetX = table.width * (Number.parseFloat(target.left) / 100);
  // The hand row is above the player name/chips card at the seat coordinate.
  const targetY = table.height * ((Number.parseFloat(target.top) - 6) / 100);
  const x = targetX - table.width * 0.5;
  const y = targetY - table.height * 0.71;
  // Lift the card mid-flight. This gives even a short journey to the bottom
  // seat a clearly readable dealer "throw", while the card still lands exactly
  // at the projected seat's hand row.
  const lift = Math.min(82, Math.max(44, Math.hypot(x, y) * 0.14));
  return { x, y, midX: x * 0.46, midY: y * 0.46 - lift };
}
