/**
 * TEX-68 lobby table geometry (pure, no DOM).
 *
 * The lobby felt is a stadium ("跑道形椭圆"): a horizontal one on wide screens and a
 * vertical one on phones. Seats are anchored on the rail and numbered clockwise from
 * the bottom. Percentages are relative to the felt box; CSS chooses which set applies
 * via a media query, so server and client render the same markup.
 *
 * `lobbyLayoutMetrics` is the single source of truth for card, chip and felt sizes:
 * the table component passes it to CSS as custom properties and the unit tests use it
 * to prove that 2–10 full, all-ready seats never overlap.
 */
export type LobbySeatSide = "top" | "bottom" | "left" | "right";
export type LobbyTableOrientation = "landscape" | "portrait";

export interface LobbySeatPlacement {
  readonly seat: number;
  readonly side: LobbySeatSide;
  /** Horizontal anchor, percentage of the felt width. */
  readonly x: number;
  /** Vertical anchor, percentage of the felt height. */
  readonly y: number;
}

export const lobbyLayoutMetrics = {
  landscape: {
    /** Felt width / height. */
    feltAspect: 1.65,
    seatWidth: 108,
    seatHeight: 72,
    /** "✓ READY" stamp anchored on the inner card edge. */
    chipWidth: 66,
    chipHeight: 22,
    /** Fraction of the card's width that sits outside the rail on the left/right side. */
    sideOutset: 0.5,
  },
  portrait: {
    feltAspect: 0.5,
    seatWidth: 84,
    seatHeight: 60,
    /** Compact round "✓" stamp. */
    chipWidth: 20,
    chipHeight: 20,
    /** Side seats are offset outwards: translate(-70%) on the left and (-30%) on the right. */
    sideOutset: 0.7,
  },
  /** Share of the ready stamp pushed outside the card edge, towards the table centre. */
  chipProtrusion: 0.75,
} as const;

const MAX_PER_LINE = 4;

export function lobbySeatLayout(maxPlayers: number, orientation: LobbyTableOrientation): readonly LobbySeatPlacement[] {
  const count = Math.max(2, Math.min(10, Math.trunc(maxPlayers)));
  const sides = orientation === "landscape" ? landscapeSides(count) : portraitSides(count);
  const aspect = lobbyLayoutMetrics[orientation].feltAspect;
  return sides.map((side, seat) => ({ seat, ...anchor(side, orientation, aspect), side: side.side }));
}

interface SideSlot { readonly side: LobbySeatSide; readonly along: number }

/** Clockwise from the bottom: bottom row (right→left), left end, top row (left→right), right end. */
function landscapeSides(count: number): readonly SideSlot[] {
  const ends = count >= 4 ? 1 : 0;
  const rest = count - ends * 2;
  const bottom = Math.min(MAX_PER_LINE, Math.ceil(rest / 2));
  const top = rest - bottom;
  return [
    ...line(bottom).reverse().map((along) => ({ side: "bottom" as const, along })),
    ...(ends === 1 ? [{ side: "left" as const, along: 0.5 }] : []),
    ...line(top).map((along) => ({ side: "top" as const, along })),
    ...(ends === 1 ? [{ side: "right" as const, along: 0.5 }] : []),
  ];
}

/** Clockwise from the bottom: bottom, left column (bottom→top), top, right column (top→bottom). */
function portraitSides(count: number): readonly SideSlot[] {
  const rest = count - 2;
  const left = Math.ceil(rest / 2);
  const right = rest - left;
  return [
    { side: "bottom", along: 0.5 },
    ...column(left).reverse().map((along) => ({ side: "left" as const, along })),
    { side: "top", along: 0.5 },
    ...column(right).map((along) => ({ side: "right" as const, along })),
  ];
}

/** Evenly spaced positions along a top/bottom row of a landscape table. */
function line(count: number): number[] {
  return Array.from({ length: count }, (_, index) => (index + 1) / (count + 1));
}

/** Side columns of a portrait table stay within the central 60% of its height. */
function column(count: number): number[] {
  if (count <= 1) return count === 1 ? [0.5] : [];
  const spread = Math.min(0.6, 0.2 * count);
  return Array.from({ length: count }, (_, index) => 0.5 - spread / 2 + (spread * index) / (count - 1));
}

function anchor(slot: SideSlot, orientation: LobbyTableOrientation, aspect: number): { x: number; y: number } {
  if (orientation === "landscape") {
    // Long axis is horizontal; the inset is a fraction of the felt height.
    if (slot.side === "left") return { x: 0, y: 50 };
    if (slot.side === "right") return { x: 100, y: 50 };
    const inset = stadiumInset(slot.along, aspect);
    return { x: percent(slot.along), y: percent(slot.side === "top" ? inset : 1 - inset) };
  }
  if (slot.side === "top") return { x: 50, y: 0 };
  if (slot.side === "bottom") return { x: 50, y: 100 };
  const inset = stadiumInset(slot.along, 1 / aspect);
  return { x: percent(slot.side === "left" ? inset : 1 - inset), y: percent(slot.along) };
}

/**
 * Distance from the bounding box to the rail, as a fraction of the short axis, at a
 * position along the long axis (0–1) of a stadium whose long/short ratio is `ratio`.
 */
export function stadiumInset(along: number, ratio: number): number {
  const radius = 0.5;
  const position = along * ratio;
  const fromCap = position < radius ? radius - position : position > ratio - radius ? position - (ratio - radius) : 0;
  return radius - Math.sqrt(Math.max(0, radius * radius - fromCap * fromCap));
}

function percent(fraction: number): number {
  return Math.round(fraction * 10_000) / 100;
}
