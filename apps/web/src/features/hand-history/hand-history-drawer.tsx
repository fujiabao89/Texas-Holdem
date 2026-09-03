"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import type { Card, GameEventMessage } from "@texas-holdem/protocol";

import { formatMessage, message, type MessageKey } from "../../messages/zh-CN";
import { useProjectionState } from "../../state/use-projection-state";
import { useRoomClient } from "../lobby/room-client";
import { canLoadMore, currentHandInProgress, initialDetailState, initialListState, reduceHandHistoryDetail, reduceHandHistoryList, type HandHistoryItem } from "./hand-history-model";
import { buildHandTimeline, type StageView, type TimelineEntry, type TimelineStage } from "./hand-timeline";

const numberFormat = new Intl.NumberFormat("zh-CN");
const dateTimeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const stageNameKey: Record<TimelineStage, MessageKey> = {
  PREFLOP: "history.stages.PREFLOP",
  FLOP: "history.stages.FLOP",
  TURN: "history.stages.TURN",
  RIVER: "history.stages.RIVER",
  SHOWDOWN: "history.stages.SHOWDOWN",
  RESULT: "history.stages.RESULT",
};

/**
 * Hand-history drawer (docs/05 §13): cursor-paged server list plus a
 * read-only view of the in-progress hand buffered in the projection. Opening
 * or closing it never touches table state; load failures keep the table
 * mounted and offer a local retry.
 */
export function HandHistoryDrawer({ roomId, tournamentId, onClose }: { readonly roomId: string; readonly tournamentId: string; readonly onClose: () => void }) {
  const { http, projection } = useRoomClient();
  const state = useProjectionState(projection);
  const [list, dispatchList] = useReducer(reduceHandHistoryList, initialListState);
  const [detail, dispatchDetail] = useReducer(reduceHandHistoryDetail, initialDetailState);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  // 同步锁：滚动事件先于重渲染到达时，`canLoadMore(list)` 仍读到旧的
  // `loadingMore:false`，会以同一 cursor 双发请求并把同一页追加两次；
  // ref 写入在事件处理内即时生效，杜绝重复分页。
  const loadMoreInFlight = useRef(false);

  const names = useMemo(() => new Map((state.game?.players ?? []).map((player) => [player.playerId, player.displayName])), [state.game]);
  const lookup = useCallback((playerId: string) => names.get(playerId) ?? playerId, [names]);

  const load = useCallback(async (cursor?: string) => {
    const result = await http.listHandHistory(tournamentId, roomId, { cursor });
    if (!result.ok) {
      dispatchList({ type: "FAILED" });
      return;
    }
    const { items, nextCursor } = result.data.data;
    dispatchList(cursor === undefined ? { type: "LOADED", items, nextCursor } : { type: "MORE_LOADED", items, nextCursor });
  }, [http, roomId, tournamentId]);

  useEffect(() => {
    dispatchList({ type: "LOAD" });
    void load();
  }, [load]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const loadMore = () => {
    if (loadMoreInFlight.current || !canLoadMore(list)) return;
    loadMoreInFlight.current = true;
    dispatchList({ type: "LOAD_MORE" });
    void load(list.nextCursor ?? undefined).finally(() => { loadMoreInFlight.current = false; });
  };

  const select = (handId: string) => {
    dispatchDetail({ type: "SELECT", handId });
    void (async () => {
      const result = await http.getHandHistoryDetail(tournamentId, handId, roomId);
      if (!result.ok) {
        dispatchDetail({ type: "FAILED", handId });
        return;
      }
      dispatchDetail({ type: "LOADED", handId, detail: result.data.data });
    })();
  };

  const detailHandNumber = detail.detail === null ? null : handNumberOf(detail.detail.events);

  return <div className="fixed inset-0 z-50">
    <button aria-label={message("history.close")} className="absolute inset-0 h-full w-full cursor-default bg-black/30" onClick={onClose} tabIndex={-1} type="button" />
    <section aria-label={message("history.title")} className="absolute inset-y-0 right-0 flex h-full w-full flex-col bg-white shadow-2xl sm:w-[400px]" role="dialog" aria-modal="true">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
        <h2 className="text-lg font-bold">{message("history.title")}</h2>
        <button className="min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50" onClick={onClose} ref={closeButtonRef} type="button">{message("history.close")}</button>
      </header>
      {detail.status === "IDLE" ? (
        <div className="flex-1 overflow-y-auto" onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollTop + element.clientHeight >= element.scrollHeight - 48) loadMore();
        }}>
          {currentHandInProgress(state.game?.handPhase ?? null, state.currentHandEvents.length) && (
            <section aria-labelledby="current-hand-heading" className="border-b border-neutral-200 bg-emerald-50/60 p-4">
              <h3 className="text-sm font-semibold text-emerald-900" id="current-hand-heading">{message("history.currentHand")}</h3>
              <p className="mt-0.5 text-xs text-emerald-800">{message("history.currentHandHint")}</p>
              <Timeline stages={buildHandTimeline(state.currentHandEvents)} lookup={lookup} />
            </section>
          )}
          {list.status === "LOADING" && <p aria-live="polite" className="p-4 text-sm text-slate-600">{message("history.loading")}</p>}
          {list.status === "FAILED" && <div className="grid gap-2 p-4">
            <p className="text-sm text-red-800" role="alert">{message("history.loadFailed")}</p>
            <button className="w-fit min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50" onClick={() => { dispatchList({ type: "LOAD" }); void load(); }} type="button">{message("history.retry")}</button>
          </div>}
          {list.status === "READY" && list.items.length === 0 && <p className="p-4 text-sm text-slate-600">{message("history.empty")}</p>}
          {list.status === "READY" && <ol className="divide-y divide-neutral-100">{list.items.map((item) => <HandHistoryListRow item={item} key={item.handId} lookup={lookup} onSelect={() => select(item.handId)} />)}</ol>}
          {list.loadingMore && <p aria-live="polite" className="p-3 text-sm text-slate-600">{message("history.loadingMore")}</p>}
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          {detail.status === "FAILED" ? <div className="grid gap-2 p-4">
            <p className="text-sm text-red-800" role="alert">{message("history.detailLoadFailed")}</p>
            <button className="w-fit min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50" onClick={() => detail.handId !== null && select(detail.handId)} type="button">{message("history.retry")}</button>
            <button className="w-fit min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50" onClick={() => dispatchDetail({ type: "CLOSE" })} type="button">{message("history.backToList")}</button>
          </div> : detail.detail === null ? <p aria-live="polite" className="p-4 text-sm text-slate-600">{message("history.loading")}</p> : (
            <>
              <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-2">
                <button className="min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50" onClick={() => dispatchDetail({ type: "CLOSE" })} type="button">{message("history.backToList")}</button>
                {detailHandNumber !== null && <p className="text-sm font-semibold">{formatMessage("history.handNumber", { number: detailHandNumber })}</p>}
              </div>
              <div className="flex-1 overflow-y-auto p-4"><Timeline stages={buildHandTimeline(detail.detail.events)} lookup={lookup} /></div>
            </>
          )}
        </div>
      )}
    </section>
  </div>;
}

function HandHistoryListRow({ item, lookup, onSelect }: { readonly item: HandHistoryItem; readonly lookup: (playerId: string) => string; readonly onSelect: () => void }) {
  return <li>
    <button className="grid w-full gap-1 px-4 py-3 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px]" onClick={onSelect} type="button">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 font-semibold">
        {formatMessage("history.handNumber", { number: item.handNumber })}
        <span className="text-xs font-normal text-slate-500">{dateTimeFormat.format(item.endedAt)}</span>
      </span>
      <span className="text-sm text-slate-700">{formatMessage("history.blinds", { small: item.smallBlind, big: item.bigBlind })} · {formatMessage("history.potTotal", { amount: numberFormat.format(item.potTotal) })}</span>
      {item.communityCards.length > 0 && <span className="text-sm text-slate-700">{message("history.entries.streetCards")}：{item.communityCards.map(cardLabel).join("、")}</span>}
      <span className="text-sm text-slate-700">{message("history.winner")}：{item.winnerPlayerIds.map(lookup).join("、")}</span>
      <span className="text-xs text-slate-500">{message("history.endReason")}：{item.endReason}</span>
    </button>
  </li>;
}

function Timeline({ stages, lookup }: { readonly stages: readonly StageView[]; readonly lookup: (playerId: string) => string }) {
  if (stages.length === 0) return null;
  return <div className="mt-2 grid gap-3">
    {stages.map((stage) => <section aria-label={message(stageNameKey[stage.stage])} key={stage.stage}>
      <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500">{message(stageNameKey[stage.stage])}</h4>
      <ul className="mt-1 grid gap-1">
        {stage.entries.map((entry, index) => <li className="text-sm text-slate-800" key={index}><TimelineText entry={entry} lookup={lookup} /></li>)}
      </ul>
    </section>)}
  </div>;
}

const actionKey: Record<ActionTextKey, MessageKey> = {
  CHECK: "history.entries.check",
  CALL: "history.entries.call",
  BET: "history.entries.bet",
  RAISE: "history.entries.raise",
  ALL_IN: "history.entries.allIn",
  FOLD: "history.entries.fold",
};
type ActionTextKey = "CHECK" | "CALL" | "BET" | "RAISE" | "ALL_IN" | "FOLD";

const blindKey: Record<"SMALL_BLIND" | "BIG_BLIND" | "ANTE", MessageKey> = {
  SMALL_BLIND: "history.entries.smallBlind",
  BIG_BLIND: "history.entries.bigBlind",
  ANTE: "history.entries.ante",
};

function TimelineText({ entry, lookup }: { readonly entry: TimelineEntry; readonly lookup: (playerId: string) => string }) {
  const seat = (position: number) => formatMessage("history.seatOf", { seat: position });
  switch (entry.kind) {
    case "HAND_START": return <>{formatMessage("history.entries.handStart", { number: entry.handNumber, dealer: entry.dealerSeat + 1 })}</>;
    case "BLIND": return <>{lookup(entry.playerId)}（{seat(entry.seat)}）· {formatMessage(blindKey[entry.blindType], { amount: numberFormat.format(entry.amount) })}，{message("table.streetBet")} {numberFormat.format(entry.betTo)}</>;
    case "DEAL_HOLE": return <>{lookup(entry.playerId)}（{seat(entry.seat)}）· {message("history.entries.dealHole")}</>;
    case "STREET_CARDS": return <>{message("history.entries.streetCards")}：{entry.cards.map(cardLabel).join("、")}</>;
    case "ACTION": {
      const amount = entry.action.type === "RAISE" || entry.action.type === "ALL_IN" ? entry.action.betTo : entry.action.amount;
      return <>{lookup(entry.playerId)}（{seat(entry.seat)}）：{amount === null ? message(actionKey[entry.action.type]) : formatMessage(actionKey[entry.action.type], { amount: numberFormat.format(amount) })}</>;
    }
    case "REVEAL": return <>{lookup(entry.playerId)}（{seat(entry.seat)}）{message("history.entries.reveal")}：{entry.cards.map(cardLabel).join("、")}，{formatMessage("history.entries.handRank", { label: entry.handRankLabel })}</>;
    case "UNCALLED_RETURN": return <>{lookup(entry.playerId)}（{seat(entry.seat)}）· {formatMessage("history.entries.uncalledReturn", { amount: numberFormat.format(entry.amount) })}</>;
    case "POT_AWARDED": return <>{formatMessage("history.entries.potAwarded", { index: entry.potIndex + 1, amount: numberFormat.format(entry.potAmount) })}{entry.awards.map((award) => `，${formatMessage("history.entries.award", { name: lookup(award.playerId), amount: numberFormat.format(award.amount) })}`).join("")}{entry.winningHandRankLabel !== null ? `，${formatMessage("history.entries.winningHandRank", { label: entry.winningHandRankLabel })}` : ""}</>;
    case "ELIMINATION": return <>{formatMessage("history.entries.eliminated", { name: lookup(entry.playerId), rank: formatMessage(entry.tied ? "result.tiedRank" : "table.rank", { position: entry.finishPosition }) })}</>;
    case "TOURNAMENT_END": return <>{entry.winnerPlayerId === null ? message("history.entries.tournamentEndNoChampion") : formatMessage("history.entries.tournamentEnd", { name: lookup(entry.winnerPlayerId) })}</>;
    case "WITHDRAWN": return <>{formatMessage("history.entries.withdrawn", { name: lookup(entry.playerId) })}</>;
  }
}

function handNumberOf(events: readonly GameEventMessage[]): number | null {
  for (const source of events) {
    if (source.payload.event.type === "HAND_STARTED") return source.payload.event.payload.handNumber;
  }
  return null;
}

function cardLabel(card: Card): string {
  const suit = card.suit === "CLUBS" ? message("table.suits.CLUBS") : card.suit === "DIAMONDS" ? message("table.suits.DIAMONDS") : card.suit === "HEARTS" ? message("table.suits.HEARTS") : message("table.suits.SPADES");
  return `${suit} ${card.rank}`;
}
