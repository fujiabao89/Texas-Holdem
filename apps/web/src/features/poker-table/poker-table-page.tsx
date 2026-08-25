"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import type { Card, GameSnapshot, SubmitAction } from "@texas-holdem/protocol";

import { clampWager, quickAmounts, wagerRange, wagerStep, type WagerRange } from "../betting/amounts";
import { errorMessage, formatMessage, message } from "../../messages/zh-CN";
import type { PendingCommand as TransportPendingCommand } from "../../protocol/websocket-transport";
import { useProjectionState } from "../../state/use-projection-state";
import { useLobbyConnection, useRoomClient } from "../lobby/room-client";
import { canSubmitTableAction, tableSeats } from "./table-state";

type AmountMode = WagerRange["kind"] | null;

export function PokerTablePage({ roomId }: { readonly roomId: string }) {
  const { projection, tokens, websocket, connectionState } = useRoomClient();
  const state = useProjectionState(projection);
  const [pending, setPending] = useState<TransportPendingCommand | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [retryCommand, setRetryCommand] = useState<TransportPendingCommand | null>(null);
  const [amountMode, setAmountMode] = useState<AmountMode>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [showExactInput, setShowExactInput] = useState(false);
  const [exactAmount, setExactAmount] = useState("");
  const [allInConfirmSequence, setAllInConfirmSequence] = useState<string | null>(null);
  // sessionStorage is deliberately client-only. Keep SSR and hydration output
  // identical until React has switched to the browser snapshot.
  const isBrowser = useSyncExternalStore(subscribeNever, () => true, () => false);

  useLobbyConnection(roomId);

  useEffect(() => websocket.subscribeCommandResults((next, result) => {
    if (pending?.requestId !== next.requestId) return;
    setPending(next);
    if (result.status === "REJECTED") {
      setFeedback(errorMessage(result.error?.code ?? "INVALID_MESSAGE"));
      setRetryCommand(result.error?.retryable && result.error.code !== "STALE_GAME_STATE" ? next : null);
    } else {
      setFeedback(message("table.actionAccepted"));
    }
  }), [pending?.requestId, websocket]);

  useEffect(() => websocket.subscribeProtocolErrors((code) => setFeedback(errorMessage(code))), [websocket]);

  const game = state.game;
  const hasPendingCommand = pending !== null && (pending.status === "SENDING" || (pending.status === "APPLIED_AWAITING_STATE" && (pending.appliedSequence === undefined || state.lastSequence === null || BigInt(state.lastSequence) < BigInt(pending.appliedSequence))));
  const submitEnabled = canSubmitTableAction(game, connectionState, state.actionsDisabled, hasPendingCommand);
  const legal = submitEnabled ? game?.viewer.legalActions ?? null : null;
  const range = legal === null ? null : wagerRange(legal);
  const rangeForMode = range !== null && range.kind === amountMode ? range : null;

  const submit = (action: SubmitAction) => {
    if (game === null || !submitEnabled) return;
    try {
      const command = websocket.prepareSubmitAction(game.tournamentId, game.sequence, action);
      websocket.send(command);
      setPending(command);
      setRetryCommand(null);
      setFeedback(message("table.actionPending"));
    } catch {
      setFeedback(message("table.connectionDisconnected"));
    }
  };
  const retry = () => {
    if (retryCommand === null || connectionState !== "CONNECTED") return;
    try {
      websocket.send(retryCommand);
      setPending(retryCommand);
      setRetryCommand(null);
      setFeedback(message("table.actionPending"));
    } catch {
      setFeedback(message("table.connectionDisconnected"));
    }
  };
  const chooseAmount = (next: number, nextMode: AmountMode = amountMode) => {
    if (rangeForMode === null && !(range !== null && range.kind === nextMode)) return;
    const effectiveRange = rangeForMode ?? range!;
    setAmount(clampWager(next, effectiveRange));
    setAmountMode(effectiveRange.kind);
    setShowExactInput(false);
  };

  if (!isBrowser) return <TableFrame><p aria-live="polite">{message("table.loading")}</p></TableFrame>;
  if (state.room?.status === "CLOSED") return <TableFrame><p role="alert">{message("table.roomClosed")}</p><Link className="underline" href="/">{message("room.back")}</Link></TableFrame>;
  if (connectionState === "STOPPED") return <TableFrame><p role="alert">{message("table.connectionReplaced")}</p><Link className="underline" href="/">{message("room.back")}</Link></TableFrame>;
  if (tokens.get(roomId) === null) return <TableFrame><p role="alert">{message("table.missingSession")}</p><Link className="underline" href="/join">{message("room.joinTitle")}</Link></TableFrame>;
  if (state.room !== null && state.room.roomId === roomId && !state.room.players.some((player) => player.playerId === tokens.getPlayerId(roomId))) return <TableFrame><p role="alert">{message("table.removed")}</p><Link className="underline" href="/">{message("room.back")}</Link></TableFrame>;
  if (game === null || state.room?.roomId !== roomId) return <TableFrame><p aria-live="polite">{message("table.loading")}</p></TableFrame>;

  return <TableFrame>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-bold">{message("table.title")}</h1><p className="text-sm text-neutral-600">{message("table.handPhase")}：{phaseName(game.handPhase)}</p></div>
      <ConnectionStatus connectionState={connectionState} syncing={state.actionsDisabled} />
    </header>
    <section className="rounded-3xl border-8 border-emerald-950 bg-emerald-800 p-4 text-white shadow-inner" aria-label={message("table.title")}>
      <div className="mx-auto grid min-h-52 max-w-2xl place-items-center rounded-[45%] border-2 border-emerald-300 bg-emerald-700 p-4 text-center">
        <p className="text-sm font-medium">{message("table.pot")}：{game.pots.reduce((total, pot) => total + pot.amount, 0)}</p>
        <div className="mt-3" aria-label={message("table.board")}><p className="sr-only">{message("table.board")}</p><CardRow cards={game.board} emptyLabel={message("table.noBoard")} /></div>
        <p className="mt-3 text-sm">{message("table.currentActor")}：{actorName(game) ?? message("table.waiting")}</p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" aria-label={message("room.seats")}>
        {tableSeats(game).map((player, seat) => <SeatCard game={game} room={state.room} player={player} seat={seat} key={seat} />)}
      </div>
    </section>
    <section className="grid gap-2 rounded border border-neutral-200 p-4" aria-labelledby="clock-heading"><h2 id="clock-heading" className="font-semibold">{message("table.timeBank")}</h2><ClockStatus actionDeadline={state.clock?.actionDeadline ?? game.actionDeadline} timeBankMs={state.clock?.timeBankRemainingMs ?? game.viewer.timeBankRemainingMs} /></section>
    {state.actionsDisabled && <p className="rounded bg-amber-50 p-3 text-sm" role="status">{message("table.syncing")}</p>}
    {legal !== null && <BettingControls game={game} legal={legal} rangeForMode={rangeForMode} amount={amount} showExactInput={showExactInput} exactAmount={exactAmount} allInConfirm={allInConfirmSequence === game.sequence} onAction={submit} onSelectMode={(mode) => { setAmountMode(mode); setAmount(range?.kind === mode ? range.min : null); setShowExactInput(false); }} onChooseAmount={chooseAmount} onExactChange={setExactAmount} onToggleExact={() => setShowExactInput((value) => !value)} onSetAllInConfirm={(value) => setAllInConfirmSequence(value ? game.sequence : null)} onUseTimeBank={() => { const command = websocket.prepareCommand({ type: "USE_TIME_BANK", payload: { tournamentId: game.tournamentId, expectedSequence: game.sequence } }); try { websocket.send(command); setPending(command); setFeedback(message("table.actionPending")); } catch { setFeedback(message("table.connectionDisconnected")); } }} />}
    {hasPendingCommand && <p aria-live="polite" className="text-sm text-neutral-600">{message("table.actionPending")}</p>}
    {feedback !== null && <p role="status" aria-live="polite" className="rounded border border-neutral-300 bg-neutral-50 p-3 text-sm">{feedback}</p>}
    {retryCommand !== null && <button className={buttonClass} disabled={connectionState !== "CONNECTED"} onClick={retry}>{message("table.retry")}</button>}
    {game.tournamentStatus === "FINISHED" && <RankingSummary game={game} />}
  </TableFrame>;
}

function BettingControls({ game, legal, rangeForMode, amount, showExactInput, exactAmount, allInConfirm, onAction, onSelectMode, onChooseAmount, onExactChange, onToggleExact, onSetAllInConfirm, onUseTimeBank }: { readonly game: GameSnapshot; readonly legal: NonNullable<GameSnapshot["viewer"]["legalActions"]>; readonly rangeForMode: WagerRange | null; readonly amount: number | null; readonly showExactInput: boolean; readonly exactAmount: string; readonly allInConfirm: boolean; readonly onAction: (action: SubmitAction) => void; readonly onSelectMode: (mode: AmountMode) => void; readonly onChooseAmount: (amount: number, mode?: AmountMode) => void; readonly onExactChange: (value: string) => void; readonly onToggleExact: () => void; readonly onSetAllInConfirm: (value: boolean) => void; readonly onUseTimeBank: () => void }) {
  const currentRange = rangeForMode;
  const step = wagerStep(game.blindLevel.bigBlind);
  const displayedAmount = currentRange === null ? 0 : clampWager(amount ?? currentRange.min, currentRange);
  const exactNumber = Number(exactAmount);
  const exactValid = currentRange !== null && Number.isInteger(exactNumber) && exactNumber >= currentRange.min && exactNumber <= currentRange.max;
  const quick = useMemo(() => currentRange === null ? [] : quickAmounts(game, currentRange), [currentRange, game]);
  const submitAmount = () => {
    if (currentRange === null) return;
    onAction(currentRange.kind === "BET" ? { type: "BET", betTo: displayedAmount } : { type: "RAISE", raiseTo: displayedAmount });
  };
  return <section className="grid gap-3 rounded border border-neutral-200 p-4" aria-labelledby="actions-heading">
    <h2 id="actions-heading" className="font-semibold">{message("betting.actions")}</h2>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {legal.canFold && <ActionButton label={message("betting.fold")} onClick={() => onAction({ type: "FOLD" })} />}
      {legal.canCheck && <ActionButton label={message("betting.check")} onClick={() => onAction({ type: "CHECK" })} />}
      {legal.canCall && <ActionButton label={formatMessage("betting.call", { amount: legal.callAmount })} onClick={() => onAction({ type: "CALL" })} />}
      {legal.canBet && <ActionButton label={message("betting.bet")} onClick={() => onSelectMode("BET")} />}
      {legal.canRaise && <ActionButton label={message("betting.raise")} onClick={() => onSelectMode("RAISE")} />}
      {legal.canAllIn && <ActionButton label={allInConfirm ? formatMessage("betting.confirmAllIn", { amount: legal.allInTo }) : formatMessage("betting.allIn", { amount: legal.allInTo })} onClick={() => allInConfirm ? onAction({ type: "ALL_IN" }) : onSetAllInConfirm(true)} />}
      {game.actionDeadline !== null && game.viewer.timeBankRemainingMs > 0 && <ActionButton label={message("table.useTimeBank")} onClick={onUseTimeBank} />}
    </div>
    {currentRange !== null && <div className="grid gap-3 rounded bg-neutral-50 p-3">
      <p className="text-sm">{formatMessage("betting.range", { min: currentRange.min, max: currentRange.max })}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{quick.map((item) => <ActionButton key={item.label} label={`${item.label} · ${item.amount}`} onClick={() => onChooseAmount(item.amount, currentRange.kind)} />)}</div>
      <div className="flex items-center gap-2"><ActionButton label="−" ariaLabel={message("betting.decrease")} onClick={() => onChooseAmount(displayedAmount - step, currentRange.kind)} /><input className="w-full accent-emerald-700" type="range" aria-label={message("betting.amount")} min={currentRange.min} max={currentRange.max} step={step} value={displayedAmount} onChange={(event) => onChooseAmount(Number(event.target.value), currentRange.kind)} /><ActionButton label="+" ariaLabel={message("betting.increase")} onClick={() => onChooseAmount(displayedAmount + step, currentRange.kind)} /></div>
      <div className="flex flex-wrap items-center gap-2"><button className="min-h-11 rounded border px-3 py-2 text-sm" onClick={onToggleExact}>{message("betting.openExactInput")}</button><output aria-live="polite" className="font-semibold">{displayedAmount}</output>{showExactInput && <label className="grid gap-1 text-sm">{message("betting.amountInput")}<input className="min-h-11 rounded border px-3 py-2" inputMode="numeric" value={exactAmount} onChange={(event) => onExactChange(event.target.value)} onBlur={() => { if (exactValid) onChooseAmount(exactNumber, currentRange.kind); }} /></label>}</div>
      {showExactInput && !exactValid && exactAmount !== "" && <p className="text-sm text-red-700" role="alert">{message("betting.invalidAmount")}</p>}
      <ActionButton label={currentRange.kind === "BET" ? formatMessage("betting.submitBet", { amount: displayedAmount }) : formatMessage("betting.submitRaise", { amount: displayedAmount })} disabled={showExactInput && !exactValid} onClick={submitAmount} />
    </div>}
  </section>;
}

function SeatCard({ game, room, player, seat }: { readonly game: GameSnapshot; readonly room: ReturnType<typeof useProjectionState>["room"]; readonly player: GameSnapshot["players"][number] | null; readonly seat: number }) {
  if (player === null) return <div className="min-h-24 rounded border border-emerald-400/50 p-2 text-sm text-emerald-100">{formatMessage("table.seat", { position: seat + 1 })}</div>;
  const viewer = player.playerId === game.viewer.playerId;
  const active = player.playerId === game.currentActorPlayerId;
  const cards = viewer ? game.viewer.holeCards : player.revealedCards;
  const connectionStatus = room?.players.find((roomPlayer) => roomPlayer.playerId === player.playerId)?.connectionStatus;
  return <article className={`min-h-24 rounded border p-2 text-sm ${active ? "border-amber-300 bg-emerald-600" : "border-emerald-400/50"}`} aria-label={`${player.displayName}，${formatMessage("table.seat", { position: seat + 1 })}${active ? `，${message("table.currentActor")}` : ""}`}>
    <div className="flex justify-between gap-1"><strong>{player.displayName}</strong>{player.seat === game.dealerSeat && <span aria-label={message("table.dealer")}>{message("table.dealer")}</span>}</div>
    <p>{message("table.chips")}：{player.stack}</p><p>{message("table.streetBet")}：{player.streetBet}</p>
    <p>{connectionStatus === "DISCONNECTED" ? message("table.disconnected") : player.pokerStatus === "ELIMINATED" ? message("table.eliminated") : player.pokerStatus === "EXIT_PENDING" ? message("table.exitPending") : player.pokerStatus === "WITHDRAWN" ? message("table.withdrawn") : ""}</p>
    <CardRow cards={cards} hiddenCount={viewer ? Math.max(0, 2 - cards.length) : player.hasHoleCards ? Math.max(0, 2 - cards.length) : 0} />
  </article>;
}

function CardRow({ cards, hiddenCount = 0, emptyLabel }: { readonly cards: readonly Card[]; readonly hiddenCount?: number; readonly emptyLabel?: string }) {
  if (cards.length === 0 && hiddenCount === 0) return emptyLabel === undefined ? null : <span className="text-sm text-emerald-100">{emptyLabel}</span>;
  return <div className="flex flex-wrap justify-center gap-1">{cards.map((card, index) => <span className="rounded bg-white px-1.5 py-1 text-xs font-semibold text-neutral-900" aria-label={cardName(card)} key={`${card.rank}-${card.suit}-${index}`}>{card.rank}{cardSuit(card)}</span>)}{Array.from({ length: hiddenCount }, (_, index) => <span className="rounded bg-neutral-900 px-1.5 py-1 text-xs" aria-label={message("table.hiddenCard")} key={`hidden-${index}`}>🂠</span>)}</div>;
}

function ClockStatus({ actionDeadline, timeBankMs }: { readonly actionDeadline: number | null; readonly timeBankMs: number }) { return <p className="text-sm">{actionDeadline === null ? message("table.waiting") : `${message("table.deadline")}：${new Date(actionDeadline).toLocaleTimeString("zh-CN")} · ${message("table.timeBank")}：${formatMessage("table.timeBankValue", { seconds: Math.ceil(timeBankMs / 1000) })}`}</p>; }
function ConnectionStatus({ connectionState, syncing }: { readonly connectionState: string; readonly syncing: boolean }) { return <p role="status" aria-live="polite" className="text-sm">{syncing ? message("table.syncing") : connectionState === "CONNECTED" ? message("table.connectionConnected") : connectionState === "STOPPED" ? message("table.connectionReplaced") : connectionState === "CONNECTING" || connectionState === "AUTHENTICATING" ? message("table.connectionConnecting") : message("table.connectionDisconnected")}</p>; }
function RankingSummary({ game }: { readonly game: GameSnapshot }) { const players = new Map(game.players.map((player) => [player.playerId, player.displayName])); return <section aria-labelledby="rankings-heading" className="rounded border p-4"><h2 id="rankings-heading" className="font-semibold">{message("table.tournamentFinished")}</h2><ol className="mt-2 list-decimal pl-5">{game.rankings.map((ranking) => <li key={ranking.playerId}>{players.get(ranking.playerId) ?? message("table.player")} · {formatMessage("table.rank", { position: ranking.placement.from })}</li>)}</ol></section>; }
function ActionButton({ label, onClick, disabled = false, ariaLabel }: { readonly label: string; readonly onClick: () => void; readonly disabled?: boolean; readonly ariaLabel?: string }) { return <button aria-label={ariaLabel} className={buttonClass} disabled={disabled} onClick={onClick}>{label}</button>; }
function TableFrame({ children }: { readonly children: ReactNode }) { return <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 bg-white p-4 text-neutral-900 sm:p-6">{children}</main>; }
function actorName(game: GameSnapshot): string | null { return game.players.find((player) => player.playerId === game.currentActorPlayerId)?.displayName ?? null; }
function cardSuit(card: Card): string { return card.suit === "CLUBS" ? "♣" : card.suit === "DIAMONDS" ? "♦" : card.suit === "HEARTS" ? "♥" : "♠"; }
function phaseName(phase: GameSnapshot["handPhase"]): string {
  switch (phase) {
    case "PREFLOP": return message("table.phases.PREFLOP");
    case "FLOP": return message("table.phases.FLOP");
    case "TURN": return message("table.phases.TURN");
    case "RIVER": return message("table.phases.RIVER");
    case "HAND_END": return message("table.phases.HAND_END");
    default: return "—";
  }
}
function cardName(card: Card): string { return `${suitName(card.suit)} ${card.rank}`; }
function suitName(suit: Card["suit"]): string {
  switch (suit) {
    case "CLUBS": return message("table.suits.CLUBS");
    case "DIAMONDS": return message("table.suits.DIAMONDS");
    case "HEARTS": return message("table.suits.HEARTS");
    case "SPADES": return message("table.suits.SPADES");
  }
}
const buttonClass = "min-h-11 rounded border border-neutral-300 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2";
function subscribeNever(): () => void { return () => undefined; }
