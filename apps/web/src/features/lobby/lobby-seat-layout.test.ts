import { describe, expect, it } from "vitest";
import { lobbyLayoutMetrics, lobbySeatLayout, type LobbySeatPlacement, type LobbyTableOrientation } from "./lobby-seat-layout";

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function boxes(placement: LobbySeatPlacement, orientation: LobbyTableOrientation, feltWidth: number) {
  const m = lobbyLayoutMetrics[orientation];
  const feltHeight = feltWidth / m.feltAspect;
  const cx = (placement.x / 100) * feltWidth;
  const cy = (placement.y / 100) * feltHeight;
  const left = placement.side === "left"
    ? cx - m.seatWidth * m.sideOutset
    : placement.side === "right"
      ? cx - m.seatWidth * (1 - m.sideOutset)
      : cx - m.seatWidth / 2;
  const card: Rect = { left, right: left + m.seatWidth, top: cy - m.seatHeight / 2, bottom: cy + m.seatHeight / 2 };
  const out = lobbyLayoutMetrics.chipProtrusion;
  let chip: Rect;
  if (placement.side === "top") {
    const top = card.bottom - m.chipHeight * (1 - out);
    chip = { left: (card.left + card.right - m.chipWidth) / 2, right: (card.left + card.right + m.chipWidth) / 2, top, bottom: top + m.chipHeight };
  } else if (placement.side === "bottom") {
    const bottom = card.top + m.chipHeight * (1 - out);
    chip = { left: (card.left + card.right - m.chipWidth) / 2, right: (card.left + card.right + m.chipWidth) / 2, top: bottom - m.chipHeight, bottom };
  } else if (placement.side === "left") {
    const leftEdge = card.right - m.chipWidth * (1 - out);
    chip = { left: leftEdge, right: leftEdge + m.chipWidth, top: cy - m.chipHeight / 2, bottom: cy + m.chipHeight / 2 };
  } else {
    const rightEdge = card.left + m.chipWidth * (1 - out);
    chip = { left: rightEdge - m.chipWidth, right: rightEdge, top: cy - m.chipHeight / 2, bottom: cy + m.chipHeight / 2 };
  }
  return { card, chip };
}

describe("TEX-68 lobby seat layout geometry", () => {
  it("distributes 2/6/10 seats cleanly around landscape and portrait ovals", () => {
    expect(lobbySeatLayout(2, "landscape").map((s) => s.side)).toEqual(["bottom", "top"]);
    expect(lobbySeatLayout(6, "landscape").map((s) => s.side)).toEqual(["bottom", "bottom", "left", "top", "top", "right"]);
    expect(lobbySeatLayout(10, "landscape").map((s) => s.side)).toEqual([
      "bottom", "bottom", "bottom", "bottom", "left", "top", "top", "top", "top", "right",
    ]);

    expect(lobbySeatLayout(2, "portrait").map((s) => s.side)).toEqual(["bottom", "top"]);
    expect(lobbySeatLayout(6, "portrait").map((s) => s.side)).toEqual(["bottom", "left", "left", "top", "right", "right"]);
    expect(lobbySeatLayout(10, "portrait").map((s) => s.side)).toEqual([
      "bottom", "left", "left", "left", "left", "top", "right", "right", "right", "right",
    ]);
  });

  it("keeps all 2–10 full ready seats and center plaque non-overlapping on desktop", () => {
    for (const feltWidth of [600, 720]) {
      const feltHeight = feltWidth / lobbyLayoutMetrics.landscape.feltAspect;
      const plaque: Rect = {
        left: feltWidth / 2 - 160,
        right: feltWidth / 2 + 160,
        top: feltHeight / 2 - 102,
        bottom: feltHeight / 2 + 102,
      };
      for (let maxPlayers = 2; maxPlayers <= 10; maxPlayers += 1) {
        const items = lobbySeatLayout(maxPlayers, "landscape").map((p) => boxes(p, "landscape", feltWidth));
        for (let i = 0; i < items.length; i += 1) {
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
    // 375px viewport -> 12px page padding each side -> 351px stage -> 62.8px frame padding each side -> 225.4px felt.
    const stageWidth = 351;
    const framePadX = lobbyLayoutMetrics.portrait.seatWidth * lobbyLayoutMetrics.portrait.sideOutset + 4;
    const feltWidth = stageWidth - framePadX * 2;
    const feltHeight = feltWidth / lobbyLayoutMetrics.portrait.feltAspect;
    const watermark: Rect = {
      left: feltWidth / 2 - 48,
      right: feltWidth / 2 + 48,
      top: feltHeight / 2 - 10,
      bottom: feltHeight / 2 + 10,
    };

    for (let maxPlayers = 2; maxPlayers <= 10; maxPlayers += 1) {
      const items = lobbySeatLayout(maxPlayers, "portrait").map((p) => boxes(p, "portrait", feltWidth));
      for (let i = 0; i < items.length; i += 1) {
        const { card, chip } = items[i]!;
        expect(framePadX + card.left).toBeGreaterThanOrEqual(0);
        expect(framePadX + card.right).toBeLessThanOrEqual(stageWidth);
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
