/**
 * TEX-68 lobby table geometry (pure, no DOM), aligned with the approved
 * `lobby-table-demo.html` zero-overlap layout.
 *
 * Each seat specifies:
 * - `x`, `y`: rail attachment point (% of felt)
 * - `tx`, `ty`: outward-biased translate fractions (e.g. -0.70 / -0.30 on mobile sides)
 * - `chipDir`: which edge of the SEAT CARD the READY chip attaches to ("top" | "bottom" | "left" | "right")
 *
 * The READY chip sits strictly OUTSIDE the card edge (`calc(100% + gap)`), so
 * chip-vs-own-card overlap is mathematically impossible at any viewport width.
 */
export type LobbyChipDir = "top" | "bottom" | "left" | "right";
export type LobbyTableOrientation = "landscape" | "portrait";

export interface LobbySeatPlacement {
  readonly seat: number;
  /** Horizontal rail anchor, percentage of the felt width. */
  readonly x: number;
  /** Vertical rail anchor, percentage of the felt height. */
  readonly y: number;
  /** Horizontal translate fraction (e.g. -0.5 for -50%, -0.7 for -70%). */
  readonly tx: number;
  /** Vertical translate fraction (e.g. -0.5 for -50%, -0.45 for -45%). */
  readonly ty: number;
  /** Which outer edge of the seat card the READY chip attaches to (inward toward felt center). */
  readonly chipDir: LobbyChipDir;
}

interface SeatSpec {
  readonly x: number;
  readonly y: number;
  readonly tx: number;
  readonly ty: number;
  readonly chipDir: LobbyChipDir;
}

export const lobbyLayoutMetrics = {
  landscape: {
    feltAspect: 1.82,
    feltMaxWidth: 660,
    seatWidth: 134,
    compactSeatWidth: 114,
    seatHeight: 50,
    compactSeatHeight: 44,
    chipWidth: 68,
    compactChipWidth: 60,
    chipHeight: 20,
    chipGap: 7,
  },
  portrait: {
    feltWidth: 214,
    seatWidth: 86,
    seatHeight: 40,
    chipWidth: 20,
    chipHeight: 20,
    chipGap: 5,
  },
} as const;

/** Exact desktop rail templates from the approved demo (2/6/10 plus clean 3–5 & 7–9 subsets). */
const DESKTOP_TEMPLATES: Readonly<Record<number, readonly SeatSpec[]>> = {
  2: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 50, y: 0, tx: -0.5, ty: -0.55, chipDir: "bottom" },
  ],
  3: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 2, y: 30, tx: -0.6, ty: -0.5, chipDir: "right" },
    { x: 98, y: 30, tx: -0.4, ty: -0.5, chipDir: "left" },
  ],
  4: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 2, y: 50, tx: -0.6, ty: -0.5, chipDir: "right" },
    { x: 50, y: 0, tx: -0.5, ty: -0.55, chipDir: "bottom" },
    { x: 98, y: 50, tx: -0.4, ty: -0.5, chipDir: "left" },
  ],
  5: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 2, y: 74, tx: -0.6, ty: -0.5, chipDir: "right" },
    { x: 2, y: 26, tx: -0.6, ty: -0.5, chipDir: "right" },
    { x: 50, y: 0, tx: -0.5, ty: -0.55, chipDir: "bottom" },
    { x: 98, y: 50, tx: -0.4, ty: -0.5, chipDir: "left" },
  ],
  6: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 2, y: 74, tx: -0.6, ty: -0.5, chipDir: "right" },
    { x: 2, y: 26, tx: -0.6, ty: -0.5, chipDir: "right" },
    { x: 50, y: 0, tx: -0.5, ty: -0.55, chipDir: "bottom" },
    { x: 98, y: 26, tx: -0.4, ty: -0.5, chipDir: "left" },
    { x: 98, y: 74, tx: -0.4, ty: -0.5, chipDir: "left" },
  ],
  7: [
    { x: 50, y: 100, tx: -0.5, ty: -0.4, chipDir: "top" },
    { x: 1, y: 68, tx: -0.64, ty: -0.5, chipDir: "right" },
    { x: 1, y: 32, tx: -0.64, ty: -0.5, chipDir: "right" },
    { x: 21, y: 3, tx: -0.55, ty: -0.6, chipDir: "bottom" },
    { x: 79, y: 3, tx: -0.45, ty: -0.6, chipDir: "bottom" },
    { x: 99, y: 32, tx: -0.36, ty: -0.5, chipDir: "left" },
    { x: 99, y: 68, tx: -0.36, ty: -0.5, chipDir: "left" },
  ],
  8: [
    { x: 50, y: 100, tx: -0.5, ty: -0.4, chipDir: "top" },
    { x: 21, y: 97, tx: -0.55, ty: -0.4, chipDir: "top" },
    { x: 1, y: 68, tx: -0.64, ty: -0.5, chipDir: "right" },
    { x: 1, y: 32, tx: -0.64, ty: -0.5, chipDir: "right" },
    { x: 21, y: 3, tx: -0.55, ty: -0.6, chipDir: "bottom" },
    { x: 79, y: 3, tx: -0.45, ty: -0.6, chipDir: "bottom" },
    { x: 99, y: 32, tx: -0.36, ty: -0.5, chipDir: "left" },
    { x: 99, y: 68, tx: -0.36, ty: -0.5, chipDir: "left" },
  ],
  9: [
    { x: 50, y: 100, tx: -0.5, ty: -0.4, chipDir: "top" },
    { x: 21, y: 97, tx: -0.55, ty: -0.4, chipDir: "top" },
    { x: 1, y: 68, tx: -0.64, ty: -0.5, chipDir: "right" },
    { x: 1, y: 32, tx: -0.64, ty: -0.5, chipDir: "right" },
    { x: 21, y: 3, tx: -0.55, ty: -0.6, chipDir: "bottom" },
    { x: 50, y: 0, tx: -0.5, ty: -0.6, chipDir: "bottom" },
    { x: 79, y: 3, tx: -0.45, ty: -0.6, chipDir: "bottom" },
    { x: 99, y: 32, tx: -0.36, ty: -0.5, chipDir: "left" },
    { x: 99, y: 68, tx: -0.36, ty: -0.5, chipDir: "left" },
  ],
  10: [
    { x: 50, y: 100, tx: -0.5, ty: -0.4, chipDir: "top" },
    { x: 21, y: 97, tx: -0.55, ty: -0.4, chipDir: "top" },
    { x: 1, y: 68, tx: -0.64, ty: -0.5, chipDir: "right" },
    { x: 1, y: 32, tx: -0.64, ty: -0.5, chipDir: "right" },
    { x: 21, y: 3, tx: -0.55, ty: -0.6, chipDir: "bottom" },
    { x: 50, y: 0, tx: -0.5, ty: -0.6, chipDir: "bottom" },
    { x: 79, y: 3, tx: -0.45, ty: -0.6, chipDir: "bottom" },
    { x: 99, y: 32, tx: -0.36, ty: -0.5, chipDir: "left" },
    { x: 99, y: 68, tx: -0.36, ty: -0.5, chipDir: "left" },
    { x: 79, y: 97, tx: -0.45, ty: -0.4, chipDir: "top" },
  ],
};

/** Exact mobile portrait (375px) rail templates from the approved demo: side seats push 70% outward. */
const MOBILE_TEMPLATES: Readonly<Record<number, readonly SeatSpec[]>> = {
  2: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 50, y: 0, tx: -0.5, ty: -0.55, chipDir: "bottom" },
  ],
  3: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 0, y: 34, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 100, y: 34, tx: -0.3, ty: -0.5, chipDir: "left" },
  ],
  4: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 0, y: 50, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 50, y: 0, tx: -0.5, ty: -0.55, chipDir: "bottom" },
    { x: 100, y: 50, tx: -0.3, ty: -0.5, chipDir: "left" },
  ],
  5: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 0, y: 68, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 0, y: 32, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 50, y: 0, tx: -0.5, ty: -0.55, chipDir: "bottom" },
    { x: 100, y: 50, tx: -0.3, ty: -0.5, chipDir: "left" },
  ],
  6: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 0, y: 68, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 0, y: 32, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 50, y: 0, tx: -0.5, ty: -0.55, chipDir: "bottom" },
    { x: 100, y: 32, tx: -0.3, ty: -0.5, chipDir: "left" },
    { x: 100, y: 68, tx: -0.3, ty: -0.5, chipDir: "left" },
  ],
  7: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 0, y: 74, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 0, y: 50, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 0, y: 26, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 50, y: 0, tx: -0.5, ty: -0.55, chipDir: "bottom" },
    { x: 100, y: 34, tx: -0.3, ty: -0.5, chipDir: "left" },
    { x: 100, y: 66, tx: -0.3, ty: -0.5, chipDir: "left" },
  ],
  8: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 0, y: 74, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 0, y: 50, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 0, y: 26, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 50, y: 0, tx: -0.5, ty: -0.55, chipDir: "bottom" },
    { x: 100, y: 26, tx: -0.3, ty: -0.5, chipDir: "left" },
    { x: 100, y: 50, tx: -0.3, ty: -0.5, chipDir: "left" },
    { x: 100, y: 74, tx: -0.3, ty: -0.5, chipDir: "left" },
  ],
  9: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 0, y: 80, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 0, y: 60, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 0, y: 40, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 0, y: 20, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 50, y: 0, tx: -0.5, ty: -0.55, chipDir: "bottom" },
    { x: 100, y: 26, tx: -0.3, ty: -0.5, chipDir: "left" },
    { x: 100, y: 50, tx: -0.3, ty: -0.5, chipDir: "left" },
    { x: 100, y: 74, tx: -0.3, ty: -0.5, chipDir: "left" },
  ],
  10: [
    { x: 50, y: 100, tx: -0.5, ty: -0.45, chipDir: "top" },
    { x: 0, y: 80, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 0, y: 60, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 0, y: 40, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 0, y: 20, tx: -0.7, ty: -0.5, chipDir: "right" },
    { x: 50, y: 0, tx: -0.5, ty: -0.55, chipDir: "bottom" },
    { x: 100, y: 20, tx: -0.3, ty: -0.5, chipDir: "left" },
    { x: 100, y: 40, tx: -0.3, ty: -0.5, chipDir: "left" },
    { x: 100, y: 60, tx: -0.3, ty: -0.5, chipDir: "left" },
    { x: 100, y: 80, tx: -0.3, ty: -0.5, chipDir: "left" },
  ],
};

export function lobbySeatLayout(maxPlayers: number, orientation: LobbyTableOrientation): readonly LobbySeatPlacement[] {
  const count = Math.max(2, Math.min(10, Math.trunc(maxPlayers)));
  const specs = (orientation === "landscape" ? DESKTOP_TEMPLATES[count] : MOBILE_TEMPLATES[count]) ?? DESKTOP_TEMPLATES[6]!;
  return specs.map((spec, seat) => ({ seat, ...spec }));
}

export function mobileFeltHeight(maxPlayers: number): number {
  const count = Math.max(2, Math.min(10, Math.trunc(maxPlayers)));
  if (count >= 9) return 416;
  if (count >= 7) return 368;
  if (count >= 5) return 320;
  if (count >= 3) return 260;
  return 224;
}

export function isCompactDesktopTable(maxPlayers: number): boolean {
  return maxPlayers >= 7;
}
