/**
 * Presentation-only geometry for a card travelling from the visible table deck
 * to a seat's hand area. It contains no card, rule, or projection data.
 */
export function dealFlightVector(
  table: { readonly width: number; readonly height: number },
  target: { readonly left: string; readonly top: string },
): { readonly x: number; readonly y: number } {
  const targetX = table.width * (Number.parseFloat(target.left) / 100);
  // The hand row is above the player name/chips card at the seat coordinate.
  const targetY = table.height * ((Number.parseFloat(target.top) - 6) / 100);
  return { x: targetX - table.width * 0.5, y: targetY - table.height * 0.64 };
}
