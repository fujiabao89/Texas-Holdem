import { describe, expect, it } from "vitest";
import {
  isCompactDesktopTable,
  lobbyLayoutMetrics,
  lobbySeatLayout,
  mobileFeltHeight,
  type LobbySeatPlacement,
  type LobbyTableOrientation,
} from "./lobby-seat-layout";

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function boxes(placement: LobbySeatPlacement, orientation: LobbyTableOrientation, maxPlayers: number, feltWidth: number) {
  const compact = orientation === "landscape" && isCompactDesktopTable(maxPlayers);
  const feltHeight = orientation === "landscape"
    ? feltWidth / lobbyLayoutMetrics.landscape.feltAspect
    : mobileFeltHeight(maxPlayers);
  const seatW = orientation === "landscape"
    ? (compact ? lobbyLayoutMetrics.landscape.compactSeatWidth : lobbyLayoutMetrics.landscape.seatWidth)
    : lobbyLayoutMetrics.portrait.seatWidth;
  const seatH = orientation === "landscape"
    ? (compact ? lobbyLayoutMetrics.landscape.compactSeatHeight : lobbyLayoutMetrics.landscape.seatHeight)
    : lobbyLayoutMetrics.portrait.seatHeight;
  const chipW = orientation === "landscape"
    ? (compact ? lobbyLayoutMetrics.landscape.compactChipWidth : lobbyLayoutMetrics.landscape.chipWidth)
    : lobbyLayoutMetrics.portrait.chipWidth;
  const chipH = orientation === "landscape" ? lobbyLayoutMetrics.landscape.chipHeight : lobbyLayoutMetrics.portrait.chipHeight;
  const chipGap = orientation === "landscape" ? lobbyLayoutMetrics.landscape.chipGap : lobbyLayoutMetrics.portrait.chipGap;

  const anchorX = (placement.x / 100) * feltWidth;
  const anchorY = (placement.y / 100) * feltHeight;
  const left = anchorX + placement.tx * seatW;
  const top = anchorY + placement.ty * seatH;
  const card: Rect = { left, right: left + seatW, top, bottom: top + seatH };

  let chip: Rect;
  if (placement.chipDir === "top") {
    chip = { left: (card.left + card.right - chipW) / 2, right: (card.left + card.right + chipW) / 2, top: card.top - chipGap - chipH, bottom: card.top - chipGap };
  } else if (placement.chipDir === "bottom") {
    chip = { left: (card.left + card.right - chipW) / 2, right: (card.left + card.right + chipW) / 2, top: card.bottom + chipGap, bottom: card.bottom + chipGap + chipH };
  } else if (placement.chipDir === "right") {
    chip = { left: card.right + chipGap, right: card.right + chipGap + chipW, top: (card.top + card.bottom - chipH) / 2, bottom: (card.top + card.bottom + chipH) / 2 };
  } else {
    chip = { left: card.left - chipGap - chipW, right: card.left - chipGap, top: (card.top + card.bottom - chipH) / 2, bottom: (card.top + card.bottom + chipH) / 2 };
  }
  return { card, chip };
}

describe("TEX-68 lobby seat layout geometry (demo-aligned)", () => {
  it("matches the approved demo chip directions for 2/6/10 seats on desktop and mobile", () => {
    expect(lobbySeatLayout(2, "landscape").map((s) => s.chipDir)).toEqual(["top", "bottom"]);
    expect(lobbySeatLayout(6, "landscape").map((s) => s.chipDir)).toEqual(["top", "right", "right", "bottom", "left", "left"]);
    expect(lobbySeatLayout(10, "landscape").map((s) => s.chipDir)).toEqual([
      "top", "top", "right", "right", "bottom", "bottom", "bottom", "left", "left", "top",
    ]);

    expect(lobbySeatLayout(2, "portrait").map((s) => s.chipDir)).toEqual(["top", "bottom"]);
    expect(lobbySeatLayout(6, "portrait").map((s) => s.chipDir)).toEqual(["top", "right", "right", "bottom", "left", "left"]);
    expect(lobbySeatLayout(10, "portrait").map((s) => s.chipDir)).toEqual([
      "top", "right", "right", "right", "right", "bottom", "left", "left", "left", "left",
    ]);
  });

  it("keeps every ready chip strictly outside its own card and non-overlapping with seats/plaque on desktop", () => {
    for (const feltWidth of [580, 660]) {
      const feltHeight = feltWidth / lobbyLayoutMetrics.landscape.feltAspect;
      const plaque: Rect = {
        left: feltWidth / 2 - 140,
        right: feltWidth / 2 + 140,
        top: feltHeight / 2 - 86,
        bottom: feltHeight / 2 + 86,
      };
      for (let maxPlayers = 2; maxPlayers <= 10; maxPlayers += 1) {
        const items = lobbySeatLayout(maxPlayers, "landscape").map((p) => boxes(p, "landscape", maxPlayers, feltWidth));
        for (let i = 0; i < items.length; i += 1) {
          // Never overlaps its OWN seat card!
          expect(overlaps(items[i]!.chip, items[i]!.card)).toBe(false);
          expect(overlaps(items[i]!.card, plaque)).toBe(false);
          expect(overlaps(items[i]!.chip, plaque)).toBe(false);
          for (let j = i + 1; j < items.length; j += 1) {
            expect(overlaps(items[i]!.card, items[j]!.card)).toBe(false);
            expect(overlaps(items[i]!.chip, items[j]!.chip)).toBe(false);
            expect(overlaps(items[i]!.chip, items[j]!.card)).toBe(false);
            expect(overlaps(items[j]!.chip, items[i]!.card)).toBe(false);
          }
        }
      }
    }
  });

  it("keeps all 2–10 full ready seats unclipped and non-overlapping at 375px portrait", () => {
    const viewport = 375;
    const feltWidth = lobbyLayoutMetrics.portrait.feltWidth;
    const feltLeft = (viewport - feltWidth) / 2;

    for (let maxPlayers = 2; maxPlayers <= 10; maxPlayers += 1) {
      const feltHeight = mobileFeltHeight(maxPlayers);
      const watermark: Rect = {
        left: feltWidth / 2 - 34,
        right: feltWidth / 2 + 34,
        top: feltHeight / 2 - 28,
        bottom: feltHeight / 2 + 28,
      };
      const items = lobbySeatLayout(maxPlayers, "portrait").map((p) => boxes(p, "portrait", maxPlayers, feltWidth));
      for (let i = 0; i < items.length; i += 1) {
        const { card, chip } = items[i]!;
        expect(overlaps(chip, card)).toBe(false);
        expect(feltLeft + card.left).toBeGreaterThanOrEqual(0);
        expect(feltLeft + card.right).toBeLessThanOrEqual(viewport);
        expect(overlaps(card, watermark)).toBe(false);
        expect(overlaps(chip, watermark)).toBe(false);
        for (let j = i + 1; j < items.length; j += 1) {
          expect(overlaps(card, items[j]!.card)).toBe(false);
          expect(overlaps(chip, items[j]!.chip)).toBe(false);
          expect(overlaps(chip, items[j]!.card)).toBe(false);
          expect(overlaps(items[j]!.chip, card)).toBe(false);
        }
      }
    }
  });
});
