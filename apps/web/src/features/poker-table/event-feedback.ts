import type { GameEvent, GameSnapshot } from "@texas-holdem/protocol";

import { formatMessage, message } from "../../messages/zh-CN";

type PublicHandRank = Extract<GameEvent, { type: "PLAYER_REVEALED" }>["payload"]["handRank"];
export type HandOutcomeEvent = Extract<GameEvent, { type: "PLAYER_REVEALED" | "POT_AWARDED" }>;
export type Point = { readonly x: number; readonly y: number };
export type MeasuredRect = Point & { readonly width: number; readonly height: number };

/** Only translates the server category; no evaluator or card-ranking logic. */
export function publicHandRankName(rank: PublicHandRank): string {
  return message(`table.feedback.ranks.${rank.category}`);
}

export function potName(index: number): string {
  return index === 0 ? message("table.feedback.mainPot") : formatMessage("table.feedback.sidePot", { index });
}

export function publicPlayerName(game: GameSnapshot, playerId: string): string {
  return game.players.find((player) => player.playerId === playerId)?.displayName ?? message("table.player");
}

export function actionFeedback(event: GameEvent): string | null {
  switch (event.type) {
    case "BLIND_POSTED": return formatMessage(`table.feedback.${event.payload.blindType}`, { amount: event.payload.amount });
    case "PLAYER_CHECKED": return message("betting.check");
    case "PLAYER_CALLED": return formatMessage("betting.call", { amount: event.payload.amount });
    case "PLAYER_BET": return formatMessage("table.feedback.bet", { amount: event.payload.amount });
    case "PLAYER_RAISED": return formatMessage("table.feedback.raiseTo", { amount: event.payload.raiseTo });
    case "PLAYER_ALL_IN": return formatMessage("betting.allIn", { amount: event.payload.betTo });
    case "PLAYER_FOLDED": return message("table.folded");
    case "UNCALLED_BET_RETURNED": return formatMessage("table.feedback.returned", { amount: event.payload.amount });
    case "PLAYER_WITHDRAWN": return message("table.withdrawn");
    case "PLAYER_ELIMINATED": return formatMessage("table.feedback.eliminatedAt", { position: event.payload.finishPosition });
    default: return null;
  }
}

/** Pixel centres relative to the table's padding box (not its outer border). */
export function relativeCenter(table: MeasuredRect, target: MeasuredRect, border: Point = { x: 0, y: 0 }): Point {
  return { x: target.x + target.width / 2 - table.x - border.x, y: target.y + target.height / 2 - table.y - border.y };
}

/** A compositor-only path; geometry has no knowledge of chips, cards or rules. */
export function feedbackFlight(from: Point, to: Point): { readonly origin: Point; readonly delta: Point } {
  return { origin: from, delta: { x: to.x - from.x, y: to.y - from.y } };
}

export function awardedTo(event: GameEvent | null, playerId: string): number | null {
  return event?.type === "POT_AWARDED" ? event.payload.awards.find((award) => award.playerId === playerId)?.amount ?? null : null;
}
