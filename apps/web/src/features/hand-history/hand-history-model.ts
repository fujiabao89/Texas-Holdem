import type { HandHistoryDetailResponse, HandHistoryListResponse } from "@texas-holdem/protocol";

/** Protocol item shape, derived from the wire schema without re-declaring it. */
export type HandHistoryItem = HandHistoryListResponse["data"]["items"][number];
export type HandHistoryDetail = HandHistoryDetailResponse["data"];

/**
 * Pure reducers for the hand-history drawer (docs/05 §13). The list keeps a
 * `nextCursor` for reverse-order pagination (20 per page by default); both
 * list and detail expose a local FAILED state so the table stays mounted and
 * the user can retry in place — never a global error page.
 */

export type LoadStatus = "IDLE" | "LOADING" | "READY" | "FAILED";

export interface HandHistoryListState {
  readonly status: LoadStatus;
  readonly items: readonly HandHistoryItem[];
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
}

export type HandHistoryListAction =
  | { readonly type: "LOAD" }
  | { readonly type: "LOAD_MORE" }
  | { readonly type: "LOADED"; readonly items: readonly HandHistoryItem[]; readonly nextCursor: string | null }
  | { readonly type: "MORE_LOADED"; readonly items: readonly HandHistoryItem[]; readonly nextCursor: string | null }
  | { readonly type: "FAILED" };

export const initialListState: HandHistoryListState = { status: "IDLE", items: [], nextCursor: null, loadingMore: false };

export function reduceHandHistoryList(state: HandHistoryListState, action: HandHistoryListAction): HandHistoryListState {
  switch (action.type) {
    case "LOAD":
      return { ...initialListState, status: "LOADING" };
    case "LOAD_MORE":
      // Only one in-flight next page; a page with no cursor has nothing more.
      return state.status === "READY" && !state.loadingMore && state.nextCursor !== null ? { ...state, loadingMore: true } : state;
    case "LOADED":
      return { status: "READY", items: action.items, nextCursor: action.nextCursor, loadingMore: false };
    case "MORE_LOADED":
      return state.status === "READY" ? { status: "READY", items: [...state.items, ...action.items], nextCursor: action.nextCursor, loadingMore: false } : state;
    case "FAILED":
      return state.loadingMore ? { ...state, loadingMore: false } : { ...state, status: "FAILED", loadingMore: false };
  }
}

export interface HandHistoryDetailState {
  readonly status: LoadStatus;
  readonly handId: string | null;
  readonly detail: HandHistoryDetail | null;
}

export type HandHistoryDetailAction =
  | { readonly type: "SELECT"; readonly handId: string }
  | { readonly type: "LOADED"; readonly handId: string; readonly detail: HandHistoryDetail }
  | { readonly type: "FAILED"; readonly handId: string }
  | { readonly type: "CLOSE" };

export const initialDetailState: HandHistoryDetailState = { status: "IDLE", handId: null, detail: null };

export function reduceHandHistoryDetail(state: HandHistoryDetailState, action: HandHistoryDetailAction): HandHistoryDetailState {
  switch (action.type) {
    case "SELECT":
      return { status: "LOADING", handId: action.handId, detail: null };
    case "LOADED":
      // Stale responses for a previously selected hand never overwrite the current one.
      return state.handId === action.handId ? { status: "READY", handId: action.handId, detail: action.detail } : state;
    case "FAILED":
      return state.handId === action.handId ? { ...state, status: "FAILED" } : state;
    case "CLOSE":
      return initialDetailState;
  }
}

/** True when the scroll sentinel should trigger another page fetch. */
export function canLoadMore(state: HandHistoryListState): boolean {
  return state.status === "READY" && !state.loadingMore && state.nextCursor !== null;
}

/**
 * True only while the buffered events belong to a hand that is actually still
 * running: settlement keeps the hand's events buffered (they share its
 * `handId`), but the projection's `handPhase` moves to `HAND_END` and must not
 * be presented as "in progress" anymore. A `null` phase means no active hand.
 */
export function currentHandInProgress(
  handPhase: "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "HAND_END" | null,
  bufferedEventCount: number,
): boolean {
  return bufferedEventCount > 0 && handPhase !== null && handPhase !== "HAND_END";
}
