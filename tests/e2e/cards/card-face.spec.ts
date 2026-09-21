import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Card, GameSnapshot } from "../../../packages/protocol/src";
import { expect, test } from "../fixtures/observability";
import { installTable, tableSnapshot } from "../animation-audio/table-fixture";

const board: Card[] = [
  { rank: "7", suit: "CLUBS" },
  { rank: "8", suit: "DIAMONDS" },
  { rank: "9", suit: "HEARTS" },
  { rank: "10", suit: "SPADES" },
  { rank: "K", suit: "DIAMONDS" },
];

function cardSnapshot(): GameSnapshot {
  const base = tableSnapshot(2, {
    handPhase: "RIVER",
    board,
    currentActorPlayerId: "player-1",
    actionDeadline: null,
    showdownDisplayUntil: null,
    viewer: {
      ...tableSnapshot().viewer,
      holeCards: [
        { rank: "A", suit: "HEARTS" },
        { rank: "J", suit: "CLUBS" },
      ],
    },
  });
  return {
    ...base,
    players: base.players.map((player) =>
      player.playerId === "player-2"
        ? {
            ...player,
            revealedCards: [
              { rank: "Q", suit: "DIAMONDS" },
              { rank: "K", suit: "CLUBS" },
            ],
          }
        : player,
    ),
  };
}

for (const viewport of [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test(`TEX-57 ${viewport.width}x${viewport.height} 牌面内容不与角标重叠且保持花色语义`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const table = await installTable(page, cardSnapshot());
    await table.open();

    const faces = page.locator(".table-card-face[data-card-rank]");
    await expect(faces).toHaveCount(9);
    // Fan rotation is an outer seat decoration. Neutralize it so DOMRect checks
    // measure the card's own coordinate system instead of rotated AABB overlap.
    await faces.evaluateAll((nodes) => {
      for (const face of nodes) (face as HTMLElement).style.transform = "none";
    });
    const violations = await faces.evaluateAll((nodes) => {
      const collisions: string[] = [];
      for (const face of nodes) {
        const label = `${face.getAttribute("data-card-variant")}:${face.getAttribute("data-card-rank")}:${face.getAttribute("data-card-suit")}`;
        const faceRect = face.getBoundingClientRect();
        const corners = [...face.querySelectorAll<HTMLElement>("[data-card-corner]")];
        const content = [
          ...face.querySelectorAll<HTMLElement>("[data-card-pip]"),
          ...face.querySelectorAll<HTMLElement>("[data-card-court]"),
        ];
        for (const item of content) {
          const itemRect = item.getBoundingClientRect();
          if (
            itemRect.left < faceRect.left - 0.5 ||
            itemRect.right > faceRect.right + 0.5 ||
            itemRect.top < faceRect.top - 0.5 ||
            itemRect.bottom > faceRect.bottom + 0.5
          ) {
            collisions.push(`${label}:content-outside-face`);
          }
          for (const corner of corners) {
            if (
              Math.min(itemRect.right, corner.getBoundingClientRect().right) -
                  Math.max(itemRect.left, corner.getBoundingClientRect().left) >
                0.5 &&
              Math.min(itemRect.bottom, corner.getBoundingClientRect().bottom) -
                  Math.max(itemRect.top, corner.getBoundingClientRect().top) >
                0.5
            ) {
              collisions.push(`${label}:content-corner-overlap`);
            }
          }
        }
        const pips = [...face.querySelectorAll<HTMLElement>("[data-card-pip]")];
        for (let left = 0; left < pips.length; left++) {
          for (let right = left + 1; right < pips.length; right++) {
            const a = pips[left]!.getBoundingClientRect();
            const b = pips[right]!.getBoundingClientRect();
            if (
              Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5
            ) {
              collisions.push(`${label}:pip-pip-overlap`);
            }
          }
        }
      }
      return collisions;
    });
    expect(violations).toEqual([]);

    const colors = await faces.evaluateAll((nodes) =>
      nodes.map((face) => ({
        suit: face.getAttribute("data-card-suit"),
        color: getComputedStyle(face).color,
        corners: [...face.querySelectorAll<HTMLElement>("[data-card-corner]")].map(
          (corner) => getComputedStyle(corner).backgroundColor,
        ),
        courtBorder: face.querySelector<HTMLElement>("[data-card-court]")
          ? getComputedStyle(face.querySelector<HTMLElement>("[data-card-court]")!).borderTopColor
          : null,
      })),
    );
    const red = new Set(
      colors.filter(({ suit }) => suit === "DIAMONDS" || suit === "HEARTS").map(({ color }) => color),
    );
    const black = new Set(
      colors.filter(({ suit }) => suit === "CLUBS" || suit === "SPADES").map(({ color }) => color),
    );
    expect(red.size).toBe(1);
    expect(black.size).toBe(1);
    expect([...red][0]).not.toBe([...black][0]);
    expect(colors.flatMap(({ corners }) => corners)).toEqual(
      expect.arrayContaining(Array.from({ length: 18 }, () => "rgba(0, 0, 0, 0)")),
    );
    expect(colors.filter(({ courtBorder }) => courtBorder !== null).map(({ courtBorder }) => courtBorder)).toEqual([
      "rgb(200, 194, 174)",
      "rgb(200, 194, 174)",
      "rgb(200, 194, 174)",
      "rgb(200, 194, 174)",
    ]);

    mkdirSync(resolve("output", "playwright"), { recursive: true });
    const path = resolve("output", "playwright", `TEX-57-cards-${viewport.width}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`TEX-57-${viewport.width}`, { path, contentType: "image/png" });
  });
}
