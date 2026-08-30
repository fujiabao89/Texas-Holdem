import { describe, expect, it } from "vitest";

import type { HandHistoryItem } from "./hand-history-model";
import { canLoadMore, currentHandInProgress, initialDetailState, initialListState, reduceHandHistoryDetail, reduceHandHistoryList } from "./hand-history-model";

function item(handNumber: number): HandHistoryItem {
  return {
    handId: `hand-${handNumber}`,
    handNumber,
    startedAt: 1_000 + handNumber,
    endedAt: 2_000 + handNumber,
    smallBlind: 5,
    bigBlind: 10,
    communityCards: [{ rank: "A", suit: "SPADES" }],
    endReason: "SHOWDOWN",
    potTotal: 30,
    winnerPlayerIds: ["player-1"],
  };
}

describe("reduceHandHistoryList", () => {
  it("starts a fresh load from any previous state", () => {
    let state = reduceHandHistoryList(initialListState, { type: "LOADED", items: [item(1)], nextCursor: "cursor-1" });
    state = reduceHandHistoryList(state, { type: "LOAD" });
    expect(state).toEqual({ status: "LOADING", items: [], nextCursor: null, loadingMore: false });
  });

  it("stores the first page and the server cursor", () => {
    const state = reduceHandHistoryList(initialListState, { type: "LOADED", items: [item(2), item(1)], nextCursor: "cursor-2" });
    expect(state).toEqual({ status: "READY", items: [item(2), item(1)], nextCursor: "cursor-2", loadingMore: false });
    expect(canLoadMore(state)).toBe(true);
  });

  it("appends the next page only while READY, keeping one in-flight page", () => {
    let state = reduceHandHistoryList(initialListState, { type: "LOADED", items: [item(2)], nextCursor: "cursor-2" });
    state = reduceHandHistoryList(state, { type: "LOAD_MORE" });
    expect(state.loadingMore).toBe(true);
    expect(canLoadMore(state)).toBe(false);
    // A second LOAD_MORE while a page is in flight is ignored.
    expect(reduceHandHistoryList(state, { type: "LOAD_MORE" })).toBe(state);
    state = reduceHandHistoryList(state, { type: "MORE_LOADED", items: [item(1)], nextCursor: null });
    expect(state).toEqual({ status: "READY", items: [item(2), item(1)], nextCursor: null, loadingMore: false });
    // No cursor left: nothing more to load.
    expect(canLoadMore(state)).toBe(false);
    expect(reduceHandHistoryList(state, { type: "LOAD_MORE" })).toBe(state);
  });

  it("keeps the loaded list when a next page fails so the table stays usable", () => {
    let state = reduceHandHistoryList(initialListState, { type: "LOADED", items: [item(2)], nextCursor: "cursor-2" });
    state = reduceHandHistoryList(state, { type: "LOAD_MORE" });
    state = reduceHandHistoryList(state, { type: "FAILED" });
    expect(state).toEqual({ status: "READY", items: [item(2)], nextCursor: "cursor-2", loadingMore: false });
  });

  it("marks the initial load as failed without keeping stale items", () => {
    const state = reduceHandHistoryList(initialListState, { type: "LOAD" });
    expect(reduceHandHistoryList(state, { type: "FAILED" })).toEqual({ status: "FAILED", items: [], nextCursor: null, loadingMore: false });
  });

  it("ignores a late page arrival after a fresh load reset the list", () => {
    const state = reduceHandHistoryList(initialListState, { type: "LOAD" });
    expect(reduceHandHistoryList(state, { type: "MORE_LOADED", items: [item(1)], nextCursor: null })).toBe(state);
  });
});

describe("currentHandInProgress", () => {
  it("shows the buffered hand only while its phase is still running", () => {
    expect(currentHandInProgress("PREFLOP", 3)).toBe(true);
    expect(currentHandInProgress("RIVER", 1)).toBe(true);
  });

  it("hides a settled hand (HAND_END) even though its events stay buffered", () => {
    expect(currentHandInProgress("HAND_END", 3)).toBe(false);
  });

  it("hides the section when there is no active hand or nothing buffered", () => {
    expect(currentHandInProgress(null, 3)).toBe(false);
    expect(currentHandInProgress("PREFLOP", 0)).toBe(false);
  });
});

describe("reduceHandHistoryDetail", () => {
  const detail = { tournamentId: "tournament-1", handId: "hand-1", startSequence: "1", endSequence: "9", events: [] };

  it("loads the selected hand and resets on close", () => {
    let state = reduceHandHistoryDetail(initialDetailState, { type: "SELECT", handId: "hand-1" });
    expect(state).toEqual({ status: "LOADING", handId: "hand-1", detail: null });
    state = reduceHandHistoryDetail(state, { type: "LOADED", handId: "hand-1", detail });
    expect(state).toEqual({ status: "READY", handId: "hand-1", detail });
    expect(reduceHandHistoryDetail(state, { type: "CLOSE" })).toEqual(initialDetailState);
  });

  it("never lets a stale response overwrite the currently selected hand", () => {
    let state = reduceHandHistoryDetail(initialDetailState, { type: "SELECT", handId: "hand-1" });
    state = reduceHandHistoryDetail(state, { type: "LOADED", handId: "hand-1", detail });
    state = reduceHandHistoryDetail(state, { type: "SELECT", handId: "hand-2" });
    expect(reduceHandHistoryDetail(state, { type: "LOADED", handId: "hand-1", detail })).toBe(state);
    expect(reduceHandHistoryDetail(state, { type: "FAILED", handId: "hand-1" })).toBe(state);
  });

  it("records a failure only for the hand still being viewed", () => {
    let state = reduceHandHistoryDetail(initialDetailState, { type: "SELECT", handId: "hand-1" });
    state = reduceHandHistoryDetail(state, { type: "FAILED", handId: "hand-1" });
    expect(state).toMatchObject({ status: "FAILED", handId: "hand-1", detail: null });
  });
});
