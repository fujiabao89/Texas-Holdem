"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import type { Card, ErrorCode, GameSnapshot, SubmitAction } from "@texas-holdem/protocol";

import { clampWager, quickAmounts, wagerRange, wagerStep, type WagerRange } from "../betting/amounts";
import { HandHistoryDrawer } from "../hand-history/hand-history-drawer";
import { errorMessage, formatMessage, message } from "../../messages/zh-CN";
import { useAudioController } from "../../audio/use-audio-controller";
import { useTableCues } from "../../audio/use-table-cues";
import { animationTimings, visualTimings } from "../../animations/timings";
import { useTablePresentation } from "../../animations/use-table-presentation";
import type { HoleDealPresentation, OutcomeEvent, PresentationOverlay as PresentationOverlayState } from "../../animations/animation-queue";
import type { PendingCommand as TransportPendingCommand } from "../../protocol/websocket-transport";
import { useProjectionState } from "../../state/use-projection-state";
import { useLobbyConnection, useRoomClient } from "../lobby/room-client";
import { actionFeedback, awardedTo, feedbackFlight, potName, publicHandRankName, publicPlayerName, relativeCenter, type Point } from "./event-feedback";
import { canSubmitTableAction, remainingTimeMs, tableSeats } from "./table-state";

type AmountMode = WagerRange["kind"] | null;
type TerminalError = Extract<ErrorCode, "AUTH_FAILED" | "UNSUPPORTED_PROTOCOL_VERSION" | "SESSION_REPLACED">;

export function PokerTablePage({ roomId }: { readonly roomId: string }) {
  const { projection, tokens, websocket, connectionState } = useRoomClient();
  const state = useProjectionState(projection);
  const [audio, soundEnabled, setSoundEnabled] = useAudioController();
  useTableCues(projection, connectionState, audio);
  const presentation = useTablePresentation(
    projection,
    websocket,
    (event, options) => audio.playEvent(event, options),
    () => audio.cancelPending(),
  );
  const [pending, setPending] = useState<TransportPendingCommand | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [retryCommand, setRetryCommand] = useState<TransportPendingCommand | null>(null);
  const [amountMode, setAmountMode] = useState<AmountMode>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [showExactInput, setShowExactInput] = useState(false);
  const [exactAmount, setExactAmount] = useState("");
  const [allInConfirmSequence, setAllInConfirmSequence] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<TerminalError | null>(null);
  const [tableElement, setTableElement] = useState<HTMLDivElement | null>(null);
  const [deckElement, setDeckElement] = useState<HTMLDivElement | null>(null);
  const wasDisconnected = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasHistoryOpen = useRef(false);
  // sessionStorage is deliberately client-only. Keep SSR and hydration output
  // identical until React has switched to the browser snapshot.
  const isBrowser = useSyncExternalStore(subscribeNever, () => true, () => false);

  useLobbyConnection(roomId);

  useEffect(() => {
    if (connectionState !== "CONNECTED") wasDisconnected.current = true;
    else if (wasDisconnected.current) { wasDisconnected.current = false; setFeedback(message("table.reconnected")); }
  }, [connectionState]);
  // Closing the drawer returns focus to its opener (docs/05 §7.6 dialog rule).
  useEffect(() => {
    if (wasHistoryOpen.current && !historyOpen) historyButtonRef.current?.focus();
    wasHistoryOpen.current = historyOpen;
  }, [historyOpen]);

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

  useEffect(() => websocket.subscribeProtocolErrors((code) => {
    setFeedback(errorMessage(code));
    if (code === "AUTH_FAILED" || code === "UNSUPPORTED_PROTOCOL_VERSION" || code === "SESSION_REPLACED") setTerminalError(code);
  }), [websocket]);

  const canonicalGame = state.game;
  const hasPendingCommand = pending !== null && (pending.status === "SENDING" || (pending.status === "APPLIED_AWAITING_STATE" && (pending.appliedSequence === undefined || state.lastSequence === null || BigInt(state.lastSequence) < BigInt(pending.appliedSequence))));
  const submitEnabled = canSubmitTableAction(canonicalGame, connectionState, state.actionsDisabled, hasPendingCommand);
  const legal = submitEnabled ? canonicalGame?.viewer.legalActions ?? null : null;
  const range = legal === null ? null : wagerRange(legal);
  const rangeForMode = range !== null && range.kind === amountMode ? range : null;

  const submit = (action: SubmitAction) => {
    if (canonicalGame === null || !submitEnabled) return;
    try {
      const command = websocket.prepareSubmitAction(canonicalGame.tournamentId, canonicalGame.sequence, action);
      websocket.send(command);
      setPending(command);
      setRetryCommand(null);
      setFeedback(message("table.actionPending"));
    } catch {
      setFeedback(message("table.connectionDisconnected"));
    }
  };
  const retry = () => {
    if (retryCommand === null || connectionState !== "CONNECTED" || hasPendingCommand) return;
    try {
      const command = { ...retryCommand, status: "SENDING" as const, appliedSequence: undefined };
      websocket.send(command);
      setPending(command);
      setRetryCommand(null);
      setFeedback(message("table.actionPending"));
    } catch {
      setFeedback(message("table.connectionDisconnected"));
    }
  };
  const chooseAmount = (next: number, nextMode: AmountMode = amountMode, closeExactInput = true) => {
    if (rangeForMode === null && !(range !== null && range.kind === nextMode)) return;
    const effectiveRange = rangeForMode ?? range!;
    setAmount(clampWager(next, effectiveRange));
    setAmountMode(effectiveRange.kind);
    if (closeExactInput) setShowExactInput(false);
    setAllInConfirmSequence(null);
  };

  if (!isBrowser) return <TableFrame><p aria-live="polite">{message("table.loading")}</p></TableFrame>;
  if (state.room?.status === "CLOSED") return <TableFrame><p role="alert">{message("table.roomClosed")}</p><Link className="underline" href="/">{message("room.back")}</Link></TableFrame>;
  if (tokens.get(roomId) === null) return <TableFrame><p role="alert">{message("table.missingSession")}</p><Link className="underline" href="/join">{message("room.joinTitle")}</Link></TableFrame>;
  if (connectionState === "STOPPED") {
    if (terminalError === "UNSUPPORTED_PROTOCOL_VERSION") return <TableFrame><p role="alert">{errorMessage(terminalError)}</p><a className="underline" href={`/room/${roomId}/table`}>{message("table.refresh")}</a></TableFrame>;
    return <TableFrame><section role="dialog" aria-modal="true" aria-labelledby="session-replaced-title" className="mx-auto grid max-w-xl gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><h1 id="session-replaced-title" className="text-xl font-bold">{message("table.sessionReplacedTitle")}</h1><p>{message("table.sessionReplacedDescription")}</p><div className="flex flex-wrap gap-3"><Link className={buttonClass} href="/">{message("room.back")}</Link><button className={buttonClass} onClick={() => { const token = tokens.get(roomId); if (token !== null) websocket.connect(roomId, token); }}>{message("table.takeOverHere")}</button></div></section></TableFrame>;
  }
  if (state.room !== null && state.room.roomId === roomId && !state.room.players.some((player) => player.playerId === tokens.getPlayerId(roomId))) return <TableFrame><p role="alert">{message("table.removed")}</p><Link className="underline" href="/">{message("room.back")}</Link></TableFrame>;
  if (canonicalGame === null || state.room?.roomId !== roomId) return <TableFrame><p aria-live="polite">{message("table.loading")}</p></TableFrame>;

  const game = presentation.game ?? canonicalGame;

  const seatSlots = tableSeatSlots(game);

  return <TableFrame reducedMotion={presentation.reducedMotion}>
    <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-sm sm:px-5">
      <div><h1 className="text-xl font-bold tracking-tight text-slate-950 sm:text-2xl">{message("table.title")}</h1><p className="mt-0.5 text-sm text-slate-500">{message("table.handPhase")}：{phaseName(game.handPhase)}</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <button className={buttonClass} onClick={() => setHistoryOpen(true)} ref={historyButtonRef} type="button">{message("history.open")}</button>
        <button className={buttonClass} aria-label={message("table.soundLabel")} aria-pressed={soundEnabled} onClick={() => { void audio.unlock(); setSoundEnabled(!soundEnabled); }} type="button">{soundEnabled ? message("table.soundOn") : message("table.soundOff")}</button>
        <ConnectionStatus connectionState={connectionState} syncing={state.actionsDisabled} />
      </div>
    </header>
    {canonicalGame.viewer.role === "ELIMINATED_SPECTATOR" && (
      <p className="mx-auto w-full max-w-6xl rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
        {message("spectator.banner")}
        <Link className="ml-2 underline" href="/">{message("spectator.exit")}</Link>
      </p>
    )}
    <section className="relative mx-auto w-full max-w-[1240px] pb-10 pt-[4.5rem] sm:pb-16 sm:pt-[5.5rem]" aria-label={message("table.title")}>
      <DealerDeck onElement={setDeckElement} />
      <div ref={setTableElement} data-presentation-mode={presentation.mode} className="table-presentation relative mx-auto aspect-[0.56/1] w-full rounded-[46%] border-[10px] border-[#172029] bg-[#00795d] shadow-[0_22px_45px_rgba(10,45,35,0.22)] sm:aspect-[1.72/1] sm:border-[18px]">
        <div aria-hidden="true" className="absolute inset-[4%] rounded-[46%] border border-emerald-300/25 bg-[radial-gradient(ellipse_at_center,rgba(20,148,111,0.28),transparent_65%)]" />
        <p aria-hidden="true" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none whitespace-nowrap font-serif text-3xl font-semibold tracking-[0.2em] text-emerald-200/10 sm:text-6xl">TEXAS HOLD&apos;EM</p>
        <div className="absolute left-1/2 top-[31%] z-20 flex -translate-x-1/2 items-center gap-2 text-center sm:top-[34%]">
          <span className="rounded-full bg-emerald-100/35 px-2.5 py-1 text-[10px] font-semibold text-emerald-50 backdrop-blur sm:px-3 sm:text-xs">{phaseName(game.handPhase)}</span>
          <span data-pot-total className="rounded-full bg-amber-300/85 px-2.5 py-1 text-[10px] font-bold text-amber-950 shadow-sm sm:px-3 sm:text-xs">{message("table.pot")}：{game.pots.reduce((total, pot) => total + pot.amount, 0)}</span>
        </div>
        <div className="absolute left-1/2 top-1/2 z-20 w-[94%] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-emerald-100/10 bg-emerald-100/20 p-2.5 shadow-inner sm:w-auto sm:p-3" aria-label={message("table.board")}>
          <p className="sr-only">{message("table.board")}</p>
          <CommunityCards cards={game.board} overlay={presentation.overlay} deckElement={deckElement} />
        </div>
        <div className="absolute left-1/2 top-[63%] z-20 flex w-[68%] -translate-x-1/2 flex-wrap justify-center gap-1" aria-label={message("table.pot")}>
          {game.pots.map((pot, index) => <span data-pot-index={index} className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold sm:text-[11px] ${presentation.overlay?.event.type === "POT_AWARDED" && presentation.overlay.event.payload.potIndex === index ? "border-amber-200 bg-amber-100 text-amber-950" : "border-emerald-100/25 bg-emerald-950/65 text-emerald-50"}`} key={index}>{potName(index)} · {pot.amount}</span>)}
        </div>
        <div data-muck className="pointer-events-none absolute left-[23%] top-[20%] rounded-lg border border-dashed border-emerald-100/20 px-2 py-1 text-[8px] text-emerald-100/60 sm:text-[10px]" aria-label={message("table.feedback.muck")}>{message("table.feedback.muck")}</div>
        <div className="absolute bottom-[8%] left-1/2 z-20 -translate-x-1/2 text-center text-[10px] font-medium text-emerald-100/75 sm:text-xs">
          <span>{message("table.currentActor")}：</span><span className="font-semibold text-white">{actorName(canonicalGame) ?? message("table.waiting")}</span>
        </div>
        <div className="absolute inset-0 z-30" aria-label={message("room.seats")}>
          {tableSeats(game).map((player, seat) => <SeatCard game={game} currentActorPlayerId={canonicalGame.currentActorPlayerId} holeDeal={presentation.holeDeal} revealedPlayerIds={presentation.revealedPlayerIds} overlay={presentation.overlay} room={state.room} player={player} seat={seat} slot={seatSlots[seat] ?? null} key={seat} />)}
        </div>
        {presentation.overlay !== null && <PresentationOverlay overlay={presentation.overlay} boardCards={game.board} game={game} tableElement={tableElement} deckElement={deckElement} key={presentation.overlay.eventKey} />}
      </div>
    </section>
    <section className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-x-4 gap-y-1 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-center shadow-sm" aria-labelledby="clock-heading"><h2 id="clock-heading" className="sr-only">{message("table.timeBank")}</h2><ClockStatus actionDeadline={state.clock?.actionDeadline ?? canonicalGame.actionDeadline} timeBankMs={state.clock?.timeBankRemainingMs ?? canonicalGame.viewer.timeBankRemainingMs} serverTime={state.clock?.serverTime ?? 0} clockKey={`${canonicalGame.handId}:${canonicalGame.currentActorPlayerId ?? "none"}`} /></section>
    {state.actionsDisabled && <p className="rounded bg-amber-50 p-3 text-sm" role="status">{message("table.syncing")}</p>}
    {presentation.notice === "SYNCED" && <p className="mx-auto w-full max-w-3xl rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm" role="status">{message("table.progressSynced")}</p>}
    {connectionState !== "CONNECTED" && <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm" role="status" aria-live="polite">{message("table.reconnectingNotice")}</p>}
    {ownPokerStatus(state.room, canonicalGame.viewer.playerId) === "EXIT_PENDING" && <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm" role="status">{message("table.exitPendingNotice")}</p>}
    {ownPokerStatus(state.room, canonicalGame.viewer.playerId) === "WITHDRAWN" && <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm" role="status">{message("table.withdrawnNotice")}</p>}
    {legal !== null && <BettingControls game={canonicalGame} legal={legal} actionDeadline={state.clock?.actionDeadline ?? canonicalGame.actionDeadline} timeBankRemainingMs={state.clock?.timeBankRemainingMs ?? canonicalGame.viewer.timeBankRemainingMs} rangeForMode={rangeForMode} amount={amount} showExactInput={showExactInput} exactAmount={exactAmount} allInConfirm={allInConfirmSequence === canonicalGame.sequence} onAction={submit} onSelectMode={(mode) => { setAmountMode(mode); setAmount(range?.kind === mode ? range.min : null); setShowExactInput(false); setAllInConfirmSequence(null); }} onChooseAmount={chooseAmount} onExactChange={(value) => { setExactAmount(value); setAllInConfirmSequence(null); }} onToggleExact={() => setShowExactInput((value) => !value)} onSetAllInConfirm={(value) => setAllInConfirmSequence(value ? canonicalGame.sequence : null)} onUseTimeBank={() => { const command = websocket.prepareCommand({ type: "USE_TIME_BANK", payload: { tournamentId: canonicalGame.tournamentId, expectedSequence: canonicalGame.sequence } }); try { websocket.send(command); setPending(command); setFeedback(message("table.actionPending")); } catch { setFeedback(message("table.connectionDisconnected")); } }} />}
    {hasPendingCommand && <p aria-live="polite" className="text-sm text-neutral-600">{message("table.actionPending")}</p>}
    {feedback !== null && <p role="status" aria-live="polite" className="rounded border border-neutral-300 bg-neutral-50 p-3 text-sm">{feedback}</p>}
    {retryCommand !== null && <button className={buttonClass} disabled={connectionState !== "CONNECTED" || hasPendingCommand} onClick={retry}>{message("table.retry")}</button>}
    <HandOutcomeSummary events={presentation.outcomeEvents} game={game} />
    {canonicalGame.tournamentStatus === "FINISHED" && <RankingSummary game={canonicalGame} />}
    {canonicalGame.tournamentStatus === "FINISHED" && (
      <Link className="mx-auto w-fit rounded-xl bg-emerald-700 px-4 py-2 text-center text-sm font-bold text-white shadow-sm hover:bg-emerald-800" href={`/room/${roomId}/result/${canonicalGame.tournamentId}`}>{message("result.view")}</Link>
    )}
    {historyOpen && <HandHistoryDrawer key={canonicalGame.tournamentId} roomId={roomId} tournamentId={canonicalGame.tournamentId} onClose={() => setHistoryOpen(false)} />}
  </TableFrame>;
}

function BettingControls({ game, legal, actionDeadline, timeBankRemainingMs, rangeForMode, amount, showExactInput, exactAmount, allInConfirm, onAction, onSelectMode, onChooseAmount, onExactChange, onToggleExact, onSetAllInConfirm, onUseTimeBank }: { readonly game: GameSnapshot; readonly legal: NonNullable<GameSnapshot["viewer"]["legalActions"]>; readonly actionDeadline: number | null; readonly timeBankRemainingMs: number; readonly rangeForMode: WagerRange | null; readonly amount: number | null; readonly showExactInput: boolean; readonly exactAmount: string; readonly allInConfirm: boolean; readonly onAction: (action: SubmitAction) => void; readonly onSelectMode: (mode: AmountMode) => void; readonly onChooseAmount: (amount: number, mode?: AmountMode, closeExactInput?: boolean) => void; readonly onExactChange: (value: string) => void; readonly onToggleExact: () => void; readonly onSetAllInConfirm: (value: boolean) => void; readonly onUseTimeBank: () => void }) {
  const currentRange = rangeForMode;
  const step = wagerStep(game.blindLevel.bigBlind);
  const displayedAmount = currentRange === null ? 0 : clampWager(amount ?? currentRange.min, currentRange);
  const exactNumber = Number(exactAmount);
  const exactValid = currentRange !== null && Number.isInteger(exactNumber) && exactNumber >= currentRange.min && exactNumber <= currentRange.max;
  const quick = useMemo(() => currentRange === null ? [] : quickAmounts(game, currentRange), [currentRange, game]);
  const submitAmount = () => {
    if (currentRange === null) return;
    const submittedAmount = showExactInput && exactValid ? exactNumber : displayedAmount;
    if (legal.canAllIn && submittedAmount === legal.allInTo) {
      onSetAllInConfirm(true);
      return;
    }
    onAction(currentRange.kind === "BET" ? { type: "BET", betTo: submittedAmount } : { type: "RAISE", raiseTo: submittedAmount });
  };
  return <section className="table-controls-enter relative z-20 mx-auto -mt-1 grid w-full max-w-xl gap-3 rounded-3xl border border-white/80 bg-white/95 p-3 shadow-[0_16px_35px_rgba(15,23,42,0.16)] backdrop-blur sm:p-4" aria-labelledby="actions-heading">
    <h2 id="actions-heading" className="sr-only">{message("betting.actions")}</h2>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {legal.canFold && <ActionButton tone="fold" label={message("betting.fold")} onClick={() => onAction({ type: "FOLD" })} />}
      {legal.canCheck && <ActionButton tone="call" label={message("betting.check")} onClick={() => onAction({ type: "CHECK" })} />}
      {legal.canCall && <ActionButton tone="call" label={formatMessage("betting.call", { amount: legal.callAmount })} onClick={() => onAction({ type: "CALL" })} />}
      {legal.canBet && <ActionButton tone="bet" label={message("betting.bet")} onClick={() => onSelectMode("BET")} />}
      {legal.canRaise && <ActionButton tone="bet" label={message("betting.raise")} onClick={() => onSelectMode("RAISE")} />}
      {legal.canAllIn && <ActionButton tone="allIn" label={allInConfirm ? formatMessage("betting.confirmAllIn", { amount: legal.allInTo }) : formatMessage("betting.allIn", { amount: legal.allInTo })} onClick={() => allInConfirm ? onAction({ type: "ALL_IN" }) : onSetAllInConfirm(true)} />}
      {actionDeadline !== null && timeBankRemainingMs > 0 && <ActionButton tone="neutral" label={message("table.useTimeBank")} onClick={onUseTimeBank} />}
    </div>
    {currentRange !== null && <div className="grid gap-3 rounded-2xl bg-slate-50 p-3">
      <p className="text-sm text-slate-600">{formatMessage("betting.range", { min: currentRange.min, max: currentRange.max })}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{quick.map((item) => <ActionButton key={item.label} tone="neutral" label={`${item.label} · ${item.amount}`} onClick={() => onChooseAmount(item.amount, currentRange.kind)} />)}</div>
      <div className="flex items-center gap-2"><ActionButton tone="neutral" label="−" ariaLabel={message("betting.decrease")} onClick={() => onChooseAmount(displayedAmount - step, currentRange.kind)} /><input className="w-full accent-emerald-700" type="range" aria-label={message("betting.amount")} min={currentRange.min} max={currentRange.max} step={step} value={displayedAmount} onChange={(event) => onChooseAmount(Number(event.target.value), currentRange.kind)} /><ActionButton tone="neutral" label="+" ariaLabel={message("betting.increase")} onClick={() => onChooseAmount(displayedAmount + step, currentRange.kind)} /></div>
      <div className="flex flex-wrap items-center gap-2"><button className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50" onClick={onToggleExact}>{message("betting.openExactInput")}</button><output aria-live="polite" className="font-semibold text-slate-950">{displayedAmount}</output>{showExactInput && <label className="grid gap-1 text-sm">{message("betting.amountInput")}<input className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2" inputMode="numeric" value={exactAmount} onChange={(event) => onExactChange(event.target.value)} onBlur={() => { if (exactValid) onChooseAmount(exactNumber, currentRange.kind, false); }} /></label>}</div>
      {showExactInput && !exactValid && exactAmount !== "" && <p className="text-sm text-red-700" role="alert">{message("betting.invalidAmount")}</p>}
      <ActionButton tone="bet" label={currentRange.kind === "BET" ? formatMessage("betting.submitBet", { amount: displayedAmount }) : formatMessage("betting.submitRaise", { amount: displayedAmount })} disabled={showExactInput && !exactValid} onClick={submitAmount} />
    </div>}
  </section>;
}

function SeatCard({ game, currentActorPlayerId, holeDeal, revealedPlayerIds, overlay, room, player, seat, slot }: { readonly game: GameSnapshot; readonly currentActorPlayerId: string | null; readonly holeDeal: HoleDealPresentation | null; readonly revealedPlayerIds: readonly string[]; readonly overlay: PresentationOverlayState | null; readonly room: ReturnType<typeof useProjectionState>["room"]; readonly player: GameSnapshot["players"][number] | null; readonly seat: number; readonly slot: number | null }) {
  if (player === null || slot === null) return <span className="sr-only">{formatMessage("table.seat", { position: seat + 1 })}</span>;
  const viewer = player.playerId === game.viewer.playerId;
  const active = player.playerId === currentActorPlayerId;
  const stagedDeal = holeDeal !== null && game.handId === holeDeal.handId;
  const stagedCardCount = stagedDeal ? Math.min(2, holeDeal.dealtCardCounts[player.playerId] ?? 0) : null;
  const revealCards = viewer && stagedDeal && holeDeal.viewerCardsForReveal.length === 2 ? holeDeal.viewerCardsForReveal : null;
  const cards = stagedDeal ? [] : viewer ? game.viewer.holeCards : revealedPlayerIds.includes(player.playerId) ? player.revealedCards : [];
  const connectionStatus = room?.players.find((roomPlayer) => roomPlayer.playerId === player.playerId)?.connectionStatus;
  const status = connectionStatus === "DISCONNECTED" ? message("table.disconnected") : player.pokerStatus === "ELIMINATED" ? message("table.eliminated") : player.pokerStatus === "EXIT_PENDING" ? message("table.exitPending") : player.pokerStatus === "WITHDRAWN" ? message("table.withdrawn") : null;
  const award = awardedTo(overlay?.event ?? null, player.playerId);
  const playerEvent = overlay !== null && "playerId" in overlay.event.payload && overlay.event.payload.playerId === player.playerId ? overlay : null;
  const eventText = playerEvent === null ? null : actionFeedback(playerEvent.event);
  const departing = playerEvent?.event.type === "PLAYER_ELIMINATED" || playerEvent?.event.type === "PLAYER_WITHDRAWN";
  return <article style={seatPosition(slot)} data-seat={seat} data-seat-slot={slot} className="table-seat absolute z-30 w-[4.75rem] -translate-x-1/2 -translate-y-1/2 text-center sm:w-36" aria-label={`${player.displayName}，${formatMessage("table.seat", { position: seat + 1 })}${active ? `，${message("table.currentActor")}` : ""}`}>
    <div data-seat-cards className={`relative z-10 mx-auto -mb-1 flex min-h-8 justify-center sm:min-h-14 ${playerEvent?.event.type === "PLAYER_FOLDED" ? "opacity-35" : ""}`}>
      {revealCards === null
        ? stagedCardCount === null
          ? <CardRow cards={cards} hiddenCount={viewer ? Math.max(0, 2 - cards.length) : player.hasHoleCards ? Math.max(0, 2 - cards.length) : 0} variant={viewer ? "hole" : "seat"} />
          : <HoleDealBacks landedCount={stagedCardCount} variant={viewer ? "hole" : "seat"} />
        : <HoleCardsReveal cards={revealCards} landedCount={stagedCardCount ?? 2} />}
    </div>
    <div data-seat-chips className={`relative rounded-xl border px-1.5 py-1.5 shadow-lg sm:rounded-2xl sm:px-3 sm:py-2 ${award !== null ? "border-amber-100 bg-[#315d37] ring-2 ring-amber-200" : active ? "border-amber-300 bg-[#315d37] ring-2 ring-amber-300/75" : "border-slate-700 bg-[#092a35]"} ${departing ? "table-seat-departing" : ""} ${player.pokerStatus === "ELIMINATED" || player.pokerStatus === "WITHDRAWN" ? "opacity-55" : ""}`} style={playerEvent === null ? undefined : { "--feedback-duration": `${playerEvent.durationMs}ms` } as CSSProperties}>
      {player.seat === game.dealerSeat && <span aria-label={message("table.dealer")} className="absolute -left-2 -top-2 grid h-5 w-5 place-items-center rounded-full border-2 border-white bg-slate-950 text-[9px] font-bold text-white shadow">D</span>}
      <strong className="block truncate text-[10px] font-semibold text-white sm:text-sm">{player.displayName}</strong>
      <span className="mt-0.5 block font-mono text-[9px] font-semibold text-emerald-300 sm:text-xs">{player.stack}</span>
      {award !== null && <span key={overlay?.eventKey} className="table-seat-award absolute -right-2 -top-3 rounded-full border border-amber-100 bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-950" style={{ "--feedback-duration": `${animationTimings.winner}ms` } as CSSProperties}>{formatMessage("table.feedback.winnerAmount", { amount: award })}</span>}
    </div>
    {eventText !== null && <span className={`table-action-badge absolute left-1/2 top-full z-50 mt-1 w-max max-w-36 -translate-x-1/2 rounded-full px-2 py-1 text-[9px] font-semibold shadow sm:text-xs ${playerEvent?.event.type === "PLAYER_ALL_IN" ? "bg-amber-200 text-amber-950" : "bg-white text-slate-900"}`} style={{ "--feedback-duration": `${playerEvent?.durationMs ?? 0}ms` } as CSSProperties} key={playerEvent?.eventKey}>{eventText}</span>}
    {(player.streetBet > 0 || status !== null) && <div className="mt-1 flex flex-col items-center gap-0.5"><span className="rounded-full bg-[#004b38] px-1.5 py-0.5 text-[8px] font-semibold text-amber-200 shadow sm:px-2 sm:text-[10px]">{player.streetBet > 0 ? `${message("table.streetBet")} ${player.streetBet}` : status}</span>{player.streetBet > 0 && status !== null && <span className="text-[8px] font-medium text-emerald-100 sm:text-[10px]">{status}</span>}</div>}
  </article>;
}

function CommunityCards({ cards, overlay, deckElement }: { readonly cards: readonly Card[]; readonly overlay: PresentationOverlayState | null; readonly deckElement: HTMLDivElement | null }) {
  const dealingBoard = overlay?.kind === "BOARD" ? overlay : null;
  return <div className="grid grid-cols-5 gap-1.5 sm:gap-2">{Array.from({ length: 5 }, (_, index) => {
    const card = cards[index];
    const dealingIndex = dealingBoard === null ? -1 : index - dealingBoard.boardStartIndex;
    const dealingCard = dealingIndex >= 0 ? dealingBoard?.boardCards[dealingIndex] : undefined;
    return card !== undefined ? <CardFace card={card} variant="board" key={`${card.rank}-${card.suit}-${index}`} />
      : dealingCard !== undefined ? <BoardDealCard card={dealingCard} index={dealingIndex} deckElement={deckElement} key={`${dealingBoard?.eventKey}:${index}`} />
        : <span aria-hidden="true" className="h-16 w-12 rounded-lg border-2 border-dashed border-emerald-200/15 bg-emerald-950/10 sm:h-24 sm:w-[4.3rem]" key={`empty-${index}`} />;
  })}</div>;
}

function BoardDealCard({ card, index, deckElement }: { readonly card: Card; readonly index: number; readonly deckElement: HTMLDivElement | null }) {
  const slotRef = useRef<HTMLSpanElement | null>(null);
  const [origin, setOrigin] = useState<Point | null>(null);
  useLayoutEffect(() => {
    if (slotRef.current === null || deckElement === null) return;
    // Measure the stationary slot, never the animated child. Cache for this
    // event so React clock updates cannot read layout during a flight.
    const slot = slotRef.current.getBoundingClientRect();
    const deck = deckElement.getBoundingClientRect();
    setOrigin({ x: deck.x + deck.width / 2 - slot.x - slot.width / 2, y: deck.y + deck.height / 2 - slot.y - slot.height / 2 });
  }, [deckElement]);
  const interval = animationTimings.flopCard + animationTimings.flopInterval;
  return <span ref={slotRef} className="relative block h-16 w-12 sm:h-24 sm:w-[4.3rem]">
    {origin !== null && <span role="img" className="board-deal-flight relative block h-full w-full" style={{ "--deal-delay": `${index * interval}ms`, "--board-origin-x": `${origin.x}px`, "--board-origin-y": `${origin.y}px` } as CSSProperties} aria-label={cardName(card)}>
    <span className="board-deal-flip relative block h-full w-full">
      <CardBack variant="board" className="board-deal-back !absolute inset-0" />
      <CardFace card={card} variant="board" className="board-deal-face !absolute inset-0" />
    </span>
    </span>}
  </span>;
}

function CardRow({ cards, hiddenCount = 0, variant = "seat" }: { readonly cards: readonly Card[]; readonly hiddenCount?: number; readonly variant?: "seat" | "hole" }) {
  if (cards.length === 0 && hiddenCount === 0) return null;
  const fan = variant === "hole" ? "first:-rotate-6 last:rotate-6" : "first:-rotate-3 last:rotate-3";
  const spacing = variant === "hole" ? "-space-x-5 sm:-space-x-7" : "-space-x-3 sm:-space-x-5";
  return <div className={`flex justify-center ${spacing}`}>{cards.map((card, index) => <CardFace card={card} variant={variant} className={fan} key={`${card.rank}-${card.suit}-${index}`} />)}{Array.from({ length: hiddenCount }, (_, index) => <CardBack variant={variant} className={fan} key={`hidden-${index}`} />)}</div>;
}

function HoleDealBacks({ landedCount, variant }: { readonly landedCount: number; readonly variant: "seat" | "hole" }) {
  const spacing = variant === "hole" ? "-space-x-5 sm:-space-x-7" : "-space-x-3 sm:-space-x-5";
  const rotation = variant === "hole" ? ["-rotate-6", "rotate-6"] : ["-rotate-3", "rotate-3"];
  return <div className={`flex justify-center ${spacing}`}>{[0, 1].map((index) => <span data-hole-slot={index} className={`relative block ${cardDimensions(variant)} shrink-0 ${rotation[index]}`} key={index}>
    {index < landedCount && <CardBack variant={variant} className="!absolute inset-0" />}
  </span>)}</div>;
}

function HoleCardsReveal({ cards, landedCount }: { readonly cards: readonly Card[]; readonly landedCount: number }) {
  return <div className="flex justify-center -space-x-5 sm:-space-x-7">{cards.map((card, index) => {
    const arrivesWithFinalFlight = index >= landedCount;
    const style = {
      "--hole-arrival-delay": `${animationTimings.deal}ms`,
      "--hole-reveal-delay": `${animationTimings.deal + animationTimings.holeRevealPause + index * animationTimings.ownCardRevealStagger}ms`,
      "--hole-reveal-duration": `${animationTimings.ownCardReveal}ms`,
    } as CSSProperties;
    return <span data-hole-slot={index} className={`relative block ${cardDimensions("hole")} shrink-0 ${index === 0 ? "-rotate-6" : "rotate-6"} ${arrivesWithFinalFlight ? "hole-reveal-arrival" : ""}`} style={style} key={`reveal-${card.rank}-${card.suit}-${index}`}>
      <span className="hole-group-flip relative block h-full w-full">
        <CardBack variant="hole" className="hole-deal-back !absolute inset-0" />
        <CardFace card={card} variant="hole" className="hole-deal-face !absolute inset-0" />
      </span>
    </span>;
  })}</div>;
}

function CardFace({ card, variant, className = "" }: { readonly card: Card; readonly variant: "board" | "seat" | "hole"; readonly className?: string }) {
  const red = card.suit === "DIAMONDS" || card.suit === "HEARTS";
  const dimensions = cardDimensions(variant);
  const cornerText = variant === "seat" ? "text-[8px] sm:text-xs" : "text-[10px] sm:text-sm";
  const color = red ? "text-rose-600" : "text-slate-900";
  return <span role="img" className={`relative block ${dimensions} ${className} shrink-0 overflow-hidden rounded-[0.45rem] border border-slate-200 bg-[linear-gradient(135deg,#ffffff,#f6f8fb)] font-serif font-bold shadow-[0_3px_7px_rgba(15,23,42,0.24)] ${color}`} aria-label={cardName(card)}>
    <CardCorner rank={card.rank} suit={cardSuit(card)} className={`left-[10%] top-[8%] ${cornerText}`} />
    <CardPips card={card} variant={variant} />
    <CardCorner rank={card.rank} suit={cardSuit(card)} className={`bottom-[8%] right-[10%] rotate-180 ${cornerText}`} />
  </span>;
}

function CardBack({ variant, className = "" }: { readonly variant: "board" | "seat" | "hole"; readonly className?: string }) {
  return <span role="img" className={`relative grid ${cardDimensions(variant)} ${className} shrink-0 place-items-center overflow-hidden rounded-[0.45rem] border border-blue-100/70 bg-[#1f4698] shadow-[0_3px_7px_rgba(15,23,42,0.24)]`} aria-label={message("table.hiddenCard")}>
    <span aria-hidden="true" className="absolute inset-1 rounded-[0.28rem] border border-blue-200/60 bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.13)_0_1px,transparent_1px_5px)]" />
    <span aria-hidden="true" className="relative h-1/3 w-1/2 rounded-full border border-blue-100/70 bg-blue-200/20" />
  </span>;
}

function CardCorner({ rank, suit, className }: { readonly rank: Card["rank"]; readonly suit: string; readonly className: string }) {
  const compactTen = rank === "10" ? "text-[8px] tracking-[-0.08em] sm:text-xs" : "";
  return <span aria-hidden="true" className={`absolute z-10 grid justify-items-center gap-px rounded-[0.1rem] bg-white/95 px-px leading-[0.95] ${className} ${compactTen}`}><span>{rank}</span><span>{suit}</span></span>;
}

function CardPips({ card, variant }: { readonly card: Card; readonly variant: "board" | "seat" | "hole" }) {
  const suit = cardSuit(card);
  const pipText = card.rank === "10" ? variant === "seat" ? "text-[8px] sm:text-[10px]" : "text-[10px] sm:text-xs" : variant === "seat" ? "text-[9px] sm:text-xs" : variant === "board" ? "text-xs sm:text-base" : "text-xs sm:text-sm";
  const layout = pipLayouts[card.rank];
  if (layout !== undefined) return <>{layout.map((pip, index) => <span aria-hidden="true" className={`absolute -translate-x-1/2 -translate-y-1/2 leading-none ${pip.inverted ? "rotate-180" : ""} ${pipText}`} style={{ left: `${pip.x}%`, top: `${pip.y}%` }} key={index}>{suit}</span>)}</>;
  if (card.rank === "A") return <span aria-hidden="true" className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 leading-none ${variant === "seat" ? "text-2xl sm:text-4xl" : "text-4xl sm:text-6xl"}`}>{suit}</span>;
  return <span aria-hidden="true" className={`absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 justify-items-center rounded-md border border-current/15 bg-white/45 px-1 leading-none ${variant === "seat" ? "text-base sm:text-2xl" : "text-2xl sm:text-4xl"}`}><span>{card.rank}</span><span className={variant === "seat" ? "text-xs sm:text-base" : "text-sm sm:text-xl"}>{suit}</span></span>;
}

function cardDimensions(variant: "board" | "seat" | "hole"): string {
  return variant === "board" ? "h-16 w-12 sm:h-24 sm:w-[4.3rem]" : variant === "hole" ? "h-[4.5rem] w-[3.2rem] sm:h-24 sm:w-[4.3rem]" : "h-10 w-[1.875rem] sm:h-16 sm:w-[2.875rem]";
}

type PipPosition = { readonly x: number; readonly y: number; readonly inverted?: boolean };
const pipLayouts: Readonly<Partial<Record<Card["rank"], readonly PipPosition[]>>> = {
  "2": [{ x: 50, y: 31 }, { x: 50, y: 69, inverted: true }],
  "3": [{ x: 50, y: 28 }, { x: 50, y: 50 }, { x: 50, y: 72, inverted: true }],
  "4": [{ x: 34, y: 29 }, { x: 66, y: 29 }, { x: 34, y: 71, inverted: true }, { x: 66, y: 71, inverted: true }],
  "5": [{ x: 34, y: 27 }, { x: 66, y: 27 }, { x: 50, y: 50 }, { x: 34, y: 73, inverted: true }, { x: 66, y: 73, inverted: true }],
  "6": [{ x: 34, y: 25 }, { x: 66, y: 25 }, { x: 34, y: 50 }, { x: 66, y: 50 }, { x: 34, y: 75, inverted: true }, { x: 66, y: 75, inverted: true }],
  "7": [{ x: 34, y: 24 }, { x: 66, y: 24 }, { x: 50, y: 37 }, { x: 34, y: 58 }, { x: 66, y: 58 }, { x: 34, y: 76, inverted: true }, { x: 66, y: 76, inverted: true }],
  "8": [{ x: 34, y: 22 }, { x: 66, y: 22 }, { x: 50, y: 36 }, { x: 34, y: 50 }, { x: 66, y: 50 }, { x: 50, y: 64, inverted: true }, { x: 34, y: 78, inverted: true }, { x: 66, y: 78, inverted: true }],
  "9": [{ x: 34, y: 22 }, { x: 66, y: 22 }, { x: 34, y: 36 }, { x: 66, y: 36 }, { x: 50, y: 50 }, { x: 34, y: 64, inverted: true }, { x: 66, y: 64, inverted: true }, { x: 34, y: 78, inverted: true }, { x: 66, y: 78, inverted: true }],
  "10": [{ x: 38, y: 26 }, { x: 62, y: 26 }, { x: 38, y: 38 }, { x: 62, y: 38 }, { x: 38, y: 50 }, { x: 62, y: 50, inverted: true }, { x: 38, y: 62, inverted: true }, { x: 62, y: 62, inverted: true }, { x: 38, y: 74, inverted: true }, { x: 62, y: 74, inverted: true }],
};

function ClockStatus({ actionDeadline, timeBankMs, serverTime, clockKey }: { readonly actionDeadline: number | null; readonly timeBankMs: number; readonly serverTime: number; readonly clockKey: string }) {
  const [countdown, setCountdown] = useState<{ readonly clockKey: string; readonly actionDeadline: number; readonly remaining: number } | null>(null);
  useEffect(() => {
    if (actionDeadline === null) return;
    const performanceNowAtReceipt = performance.now();
    const update = () => {
      const estimated = remainingTimeMs(actionDeadline, serverTime, performanceNowAtReceipt, performance.now())!;
      setCountdown((previous) => ({ clockKey, actionDeadline, remaining: previous !== null && previous.clockKey === clockKey && actionDeadline <= previous.actionDeadline ? Math.min(estimated, previous.remaining) : estimated }));
    };
    update();
    const interval = window.setInterval(update, 250);
    const onVisibilityChange = () => { if (document.visibilityState === "visible") update(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, [actionDeadline, clockKey, serverTime]);
  const remaining = actionDeadline === null ? null : (countdown?.remaining ?? null);
  return <p className="text-xs text-slate-600 sm:text-sm">{remaining === null ? message("table.waiting") : `${message("table.remainingTime")}：${formatMessage("table.timeBankValue", { seconds: Math.ceil(remaining / 1000) })} · ${message("table.timeBank")}：${formatMessage("table.timeBankValue", { seconds: Math.ceil(timeBankMs / 1000) })}`}</p>;
}
function ConnectionStatus({ connectionState, syncing }: { readonly connectionState: string; readonly syncing: boolean }) { return <p role="status" aria-live="polite" className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600">{syncing ? message("table.syncing") : connectionState === "CONNECTED" ? message("table.connectionConnected") : connectionState === "STOPPED" ? message("table.connectionReplaced") : connectionState === "CONNECTING" || connectionState === "AUTHENTICATING" ? message("table.connectionConnecting") : message("table.connectionDisconnected")}</p>; }
function PresentationOverlay({ overlay, boardCards, game, tableElement, deckElement }: { readonly overlay: PresentationOverlayState; readonly boardCards: readonly Card[]; readonly game: GameSnapshot; readonly tableElement: HTMLDivElement | null; readonly deckElement: HTMLDivElement | null }) {
  const geometry = useOverlayGeometry(tableElement, deckElement);
  const event = overlay.event;
  if (overlay.kind === "BOARD") return <span className="sr-only" role="status">{message("table.animationBoard")}</span>;
  if (event.type === "PLAYER_REVEALED") return <ShowdownShowcase cards={event.payload.cards} boardCards={boardCards} bestFiveCards={overlay.bestFiveCards} playerName={publicPlayerName(game, event.payload.playerId)} rankName={publicHandRankName(event.payload.handRank)} />;
  if (event.type === "POT_AWARDED") {
    const pot = geometry?.pots[event.payload.potIndex] ?? geometry?.pot;
    return <>
      <div className="pointer-events-none absolute inset-x-3 top-[66%] z-40 flex justify-center" role="status">
        <section className="table-pot-award max-w-full rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-center text-xs text-amber-950 shadow-lg" aria-label={potName(event.payload.potIndex)}>
          <p className="font-semibold">{potName(event.payload.potIndex)} · {event.payload.potAmount}</p>
          {event.payload.winningHandRank !== null && <p>{publicHandRankName(event.payload.winningHandRank)}</p>}
          {event.payload.awards.map((award) => <p key={award.playerId}>{formatMessage("table.feedback.award", { name: publicPlayerName(game, award.playerId), amount: award.amount })}</p>)}
        </section>
      </div>
      {pot != null && event.payload.awards.map((award) => {
        const seat = game.players.find((player) => player.playerId === award.playerId)?.seat;
        const destination = seat === undefined ? undefined : geometry?.seatChips[seat];
        return destination === undefined ? null : <ChipsFlight from={pot} to={destination} durationMs={Math.max(0, overlay.durationMs - animationTimings.winner)} delayMs={animationTimings.winner} amount={award.amount} key={award.playerId} />;
      })}
    </>;
  }
  if (event.type === "TOURNAMENT_FINISHED") return <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center px-3" role="status"><p className="table-finish rounded-2xl border border-amber-100 bg-amber-50 px-5 py-4 text-center text-sm font-semibold text-amber-950 shadow-xl">{event.payload.winnerPlayerId === null ? message("table.feedback.noChampion") : formatMessage("table.feedback.champion", { name: publicPlayerName(game, event.payload.winnerPlayerId) })}</p></div>;
  // Per-card overlays are decorative; public outcomes have a static accessible
  // summary. A deal never queues dozens of live-region announcements.
  if (geometry === null) return null;
  if (event.type === "DEAL_HOLE_CARD") {
    const target = geometry.holeSlots[`${event.payload.seat}:${event.payload.cardIndex}`] ?? geometry.seatCards[event.payload.seat];
    return target === undefined || geometry.deck === null ? null : <HoleCardDealFlight from={geometry.deck} to={target} finalHoleCardDeal={overlay.finalHoleCardDeal} variant={event.payload.playerId === game.viewer.playerId ? "hole" : "seat"} />;
  }
  if (event.type === "BURN_CARD") return geometry.deck === null || geometry.muck === null ? null : <BackCardFlight from={geometry.deck} to={geometry.muck} durationMs={overlay.durationMs} kind="burn" />;
  if (event.type === "PLAYER_FOLDED") {
    const from = geometry.seatCards[event.payload.seat];
    return from === undefined || geometry.muck === null ? null : <BackCardFlight from={from} to={geometry.muck} durationMs={overlay.durationMs} kind="fold" />;
  }
  if (event.type === "PLAYER_CHECKED") {
    const seat = geometry.seatChips[event.payload.seat];
    return seat === undefined ? null : <span className="table-check absolute z-40 grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white bg-emerald-100 text-lg font-bold text-emerald-950" style={{ left: seat.x, top: seat.y, "--feedback-duration": `${overlay.durationMs}ms` } as CSSProperties} aria-hidden="true">✓</span>;
  }
  if (event.type === "BLIND_POSTED" || event.type === "PLAYER_CALLED" || event.type === "PLAYER_BET" || event.type === "PLAYER_RAISED" || event.type === "PLAYER_ALL_IN" || event.type === "UNCALLED_BET_RETURNED") {
    const seat = geometry.seatChips[event.payload.seat];
    if (seat === undefined || geometry.pot === null || event.payload.amount === 0) return null;
    const returned = event.type === "UNCALLED_BET_RETURNED";
    return <ChipsFlight from={returned ? geometry.pot : seat} to={returned ? seat : geometry.pot} durationMs={overlay.durationMs} amount={event.payload.amount} />;
  }
  return null;
}

type OverlayGeometry = {
  readonly deck: Point | null;
  readonly muck: Point | null;
  readonly pot: Point | null;
  readonly pots: Readonly<Record<number, Point>>;
  readonly seatChips: Readonly<Record<number, Point>>;
  readonly seatCards: Readonly<Record<number, Point>>;
  readonly holeSlots: Readonly<Record<string, Point>>;
};

function useOverlayGeometry(tableElement: HTMLDivElement | null, deckElement: HTMLDivElement | null): OverlayGeometry | null {
  const [geometry, setGeometry] = useState<OverlayGeometry | null>(null);
  useLayoutEffect(() => {
    if (tableElement === null) return;
    const table = tableElement.getBoundingClientRect();
    const border = { x: tableElement.clientLeft, y: tableElement.clientTop };
    const centre = (element: Element | null): Point | null => element === null ? null : relativeCenter(table, element.getBoundingClientRect(), border);
    const seatChips: Record<number, Point> = {};
    const seatCards: Record<number, Point> = {};
    const holeSlots: Record<string, Point> = {};
    const pots: Record<number, Point> = {};
    tableElement.querySelectorAll<HTMLElement>("[data-seat]").forEach((seat) => {
      const seatIndex = Number(seat.dataset.seat);
      const chips = centre(seat.querySelector("[data-seat-chips]"));
      const cards = centre(seat.querySelector("[data-seat-cards]"));
      if (chips !== null) seatChips[seatIndex] = chips;
      if (cards !== null) seatCards[seatIndex] = cards;
      seat.querySelectorAll<HTMLElement>("[data-hole-slot]").forEach((slot) => {
        const position = centre(slot);
        if (position !== null) holeSlots[`${seatIndex}:${slot.dataset.holeSlot}`] = position;
      });
    });
    tableElement.querySelectorAll<HTMLElement>("[data-pot-index]").forEach((pot) => {
      const position = centre(pot);
      if (position !== null) pots[Number(pot.dataset.potIndex)] = position;
    });
    // A single pre-paint DOM measurement is required to launch at the real
    // source; deferred state would flash a frame at a guessed position.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGeometry({ deck: centre(deckElement), muck: centre(tableElement.querySelector("[data-muck]")), pot: centre(tableElement.querySelector("[data-pot-total]")), pots, seatChips, seatCards, holeSlots });
  }, [tableElement, deckElement]);
  return geometry;
}

function flightStyle(from: Point, to: Point, durationMs: number, delayMs = 0): CSSProperties {
  const { origin, delta } = feedbackFlight(from, to);
  return { left: origin.x, top: origin.y, "--flight-x": `${delta.x}px`, "--flight-y": `${delta.y}px`, "--feedback-duration": `${durationMs}ms`, "--feedback-delay": `${delayMs}ms` } as CSSProperties;
}

function ChipsFlight({ from, to, durationMs, delayMs = 0, amount }: { readonly from: Point; readonly to: Point; readonly durationMs: number; readonly delayMs?: number; readonly amount: number }) {
  return <span className="table-chips-flight pointer-events-none absolute z-40 flex items-center gap-1" style={flightStyle(from, to, durationMs, delayMs)} aria-hidden="true"><span className="relative block h-5 w-5 rounded-full border-[3px] border-dashed border-amber-100 bg-amber-700 shadow-[2px_3px_0_#92400e,-2px_-2px_0_#fde68a]" /><span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-950 shadow-sm">{amount}</span></span>;
}

function BackCardFlight({ from, to, durationMs, kind }: { readonly from: Point; readonly to: Point; readonly durationMs: number; readonly kind: "burn" | "fold" }) {
  return <span className={`table-back-flight table-${kind}-flight pointer-events-none absolute z-40`} style={flightStyle(from, to, durationMs)} aria-hidden="true"><CardBack variant="seat" /></span>;
}

function DealerDeck({ onElement }: { readonly onElement: (element: HTMLDivElement | null) => void }) {
  return <div ref={onElement} className="pointer-events-none absolute left-4 top-1 z-40 h-14 w-10 sm:left-6 sm:top-2 sm:h-16 sm:w-11" aria-label={message("table.deck")}>
    <span className="absolute inset-0 translate-x-2 translate-y-2 rotate-[5deg] rounded-[0.45rem] border border-blue-200/40 bg-[#16377d] shadow-[0_3px_7px_rgba(15,23,42,0.24)]" />
    <span className="absolute inset-0 translate-x-1 translate-y-1 rotate-[2deg] rounded-[0.45rem] border border-blue-100/60 bg-[#1a408c] shadow-[0_3px_7px_rgba(15,23,42,0.24)]" />
    <CardBack variant="seat" className="!absolute inset-0 !h-full !w-full" />
    <span className="absolute left-full top-1/2 ml-3 -translate-y-1/2 whitespace-nowrap rounded-full bg-slate-900/80 px-2 py-0.5 text-[9px] font-semibold text-white shadow-sm sm:text-[10px]">{message("table.deck")}</span>
  </div>;
}

function HoleCardDealFlight({ from, to, finalHoleCardDeal, variant }: { readonly from: Point; readonly to: Point; readonly finalHoleCardDeal: boolean; readonly variant: "hole" | "seat" }) {
  const { delta } = feedbackFlight(from, to);
  const lift = Math.min(46, Math.max(20, Math.hypot(delta.x, delta.y) * 0.06));
  return <div className="pointer-events-none absolute inset-0 z-40" aria-hidden="true">
    <span className={`hole-deal-flight absolute block ${cardDimensions(variant)} ${finalHoleCardDeal ? "hole-deal-flight-final" : ""}`} style={{ "--hole-origin-x": `${from.x}px`, "--hole-origin-y": `${from.y}px`, "--hole-delta-x": `${delta.x}px`, "--hole-delta-y": `${delta.y}px`, "--hole-mid-x": `${delta.x * 0.58}px`, "--hole-mid-y": `${delta.y * 0.58 - lift}px`, "--hole-deal-duration": `${animationTimings.deal}ms` } as CSSProperties}>
      <span className="relative block h-full w-full">
        <CardBack variant={variant} className="!absolute inset-0" />
      </span>
    </span>
  </div>;
}

function ShowdownShowcase({ cards, boardCards, bestFiveCards, playerName, rankName }: { readonly cards: readonly Card[]; readonly boardCards: readonly Card[]; readonly bestFiveCards: readonly Card[]; readonly playerName: string; readonly rankName: string }) {
  const candidates = [...cards, ...boardCards];
  return <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center px-2" aria-live="polite">
    <section className="showdown-showcase grid max-w-full justify-items-center gap-2 rounded-2xl border border-amber-200/70 bg-slate-950/90 p-3 shadow-2xl sm:p-4" aria-label={message("table.bestFiveServer") }>
      <p className="text-center text-xs font-semibold text-amber-100">{formatMessage("table.showdownCombining", { name: playerName })}</p>
      <div className="flex max-w-full flex-wrap justify-center gap-1.5">
        {candidates.map((card, index) => <span className={isProjectedBestCard(bestFiveCards, card) ? "showdown-source-card" : "showdown-source-card showdown-discard-card"} style={{ "--showdown-delay": `${index * visualTimings.showdownSourceStagger}ms` } as CSSProperties} key={`candidate-${card.rank}-${card.suit}-${index}`}><CardFace card={card} variant="seat" /></span>)}
      </div>
      <p className="showdown-best-label text-center text-sm font-semibold text-amber-200">{formatMessage("table.feedback.rank", { rank: rankName })}</p>
      <p className="showdown-best-label text-center text-[11px] text-amber-100">{message("table.bestFiveServer")}</p>
      <div className="flex gap-1">
        {bestFiveCards.map((card, index) => <span className="showdown-best-card" style={{ "--best-delay": `${visualTimings.showdownBestDelay + index * visualTimings.showdownBestStagger}ms` } as CSSProperties} key={`best-${card.rank}-${card.suit}-${index}`}><CardFace card={card} variant="seat" className="ring-2 ring-amber-300 shadow-[0_0_18px_rgba(252,211,77,0.7)]" /></span>)}
      </div>
    </section>
  </div>;
}

function HandOutcomeSummary({ events, game }: { readonly events: readonly OutcomeEvent[]; readonly game: GameSnapshot }) {
  if (events.length === 0) return null;
  return <section className="mx-auto grid w-full max-w-3xl gap-3 rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm" aria-labelledby="hand-outcome-heading">
    <h2 id="hand-outcome-heading" className="text-sm font-semibold text-emerald-950">{message("table.feedback.handOutcome")}</h2>
    <div className="grid gap-3 sm:grid-cols-2">{events.map((event) => event.type === "PLAYER_REVEALED" ? <div className="rounded-xl bg-slate-50 p-3" key={`reveal:${event.payload.playerId}`}>
      <p className="mb-2 text-xs font-semibold text-slate-800">{publicPlayerName(game, event.payload.playerId)} · {publicHandRankName(event.payload.handRank)}</p>
      <div className="flex gap-1" aria-label={message("table.bestFiveServer")}>{event.payload.handRank.bestFiveCards.map((card) => <CardFace card={card} variant="seat" key={`${card.rank}:${card.suit}`} />)}</div>
    </div> : <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" key={`pot:${event.payload.potIndex}`}>
      <h3 className="font-semibold">{potName(event.payload.potIndex)} · {event.payload.potAmount}</h3>
      <ul className="mt-1 space-y-1">{event.payload.awards.map((award) => <li key={award.playerId}>{formatMessage("table.feedback.award", { name: publicPlayerName(game, award.playerId), amount: award.amount })}</li>)}</ul>
    </div>)}</div>
  </section>;
}

function isProjectedBestCard(bestFiveCards: readonly Card[], candidate: Card): boolean {
  return bestFiveCards.some((card) => card.rank === candidate.rank && card.suit === candidate.suit);
}
function RankingSummary({ game }: { readonly game: GameSnapshot }) { const players = new Map(game.players.map((player) => [player.playerId, player.displayName])); return <section aria-labelledby="rankings-heading" className="mx-auto w-full max-w-xl rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm"><h2 id="rankings-heading" className="font-semibold">{message("table.tournamentFinished")}</h2><ol className="mt-2 list-decimal pl-5">{game.rankings.map((ranking) => <li key={ranking.playerId}>{players.get(ranking.playerId) ?? message("table.player")} · {formatMessage("table.rank", { position: ranking.placement.from })}</li>)}</ol></section>; }
type ButtonTone = "neutral" | "fold" | "call" | "bet" | "allIn";
function ActionButton({ label, onClick, disabled = false, ariaLabel, tone = "neutral" }: { readonly label: string; readonly onClick: () => void; readonly disabled?: boolean; readonly ariaLabel?: string; readonly tone?: ButtonTone }) { return <button aria-label={ariaLabel} className={`${actionButtonClass} ${buttonToneClass[tone]}`} disabled={disabled} onClick={onClick}>{label}</button>; }
function TableFrame({ children, reducedMotion = false }: { readonly children: ReactNode; readonly reducedMotion?: boolean }) { return <main data-reduced-motion={reducedMotion} style={tableMotionStyle} className="table-controls mx-auto flex min-h-screen w-full max-w-[1440px] flex-col gap-4 bg-[#f7faf8] p-3 text-slate-900 sm:gap-5 sm:p-6">{children}</main>; }
const tableMotionStyle = {
  "--board-flight-duration": `${visualTimings.boardFlight}ms`,
  "--board-flip-duration": `${visualTimings.boardFlip}ms`,
  "--board-flip-delay": `${visualTimings.boardFlipDelay}ms`,
  "--showdown-source-duration": `${visualTimings.showdownSource}ms`,
  "--showdown-discard-duration": `${visualTimings.showdownDiscard}ms`,
  "--showdown-discard-delay": `${visualTimings.showdownDiscardDelay}ms`,
  "--showdown-best-duration": `${visualTimings.showdownBest}ms`,
  "--showdown-label-duration": `${visualTimings.showdownLabel}ms`,
  "--showdown-label-delay": `${visualTimings.showdownLabelDelay}ms`,
  "--winner-duration": `${animationTimings.winner}ms`,
  "--hard-forward-duration": `${animationTimings.hardForwardFade}ms`,
  "--control-feedback-duration": `${visualTimings.controlFeedback}ms`,
} as CSSProperties;
function actorName(game: GameSnapshot): string | null { return game.players.find((player) => player.playerId === game.currentActorPlayerId)?.displayName ?? null; }
function ownPokerStatus(room: ReturnType<typeof useProjectionState>["room"], playerId: string): "ACTIVE" | "EXIT_PENDING" | "WITHDRAWN" | "ELIMINATED" | null { return room?.players.find((player) => player.playerId === playerId)?.pokerStatus ?? null; }
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
const seatSlotsByOpponentCount = [[], [0], [8, 2], [8, 0, 2], [8, 0, 2, 7], [8, 0, 2, 3, 7], [8, 9, 0, 1, 3, 7], [8, 9, 0, 1, 2, 3, 7], [6, 7, 8, 9, 1, 2, 3, 4], [0, 1, 2, 3, 4, 6, 7, 8, 9]] as const;
const tableSeatPositions = [
  { left: "50%", top: "8%" }, { left: "76%", top: "14%" }, { left: "91%", top: "34%" }, { left: "91%", top: "64%" }, { left: "73%", top: "83%" },
  { left: "50%", top: "93%" }, { left: "27%", top: "83%" }, { left: "9%", top: "64%" }, { left: "9%", top: "34%" }, { left: "24%", top: "14%" },
] as const;
const buttonClass = "min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700";
const actionButtonClass = "min-h-11 rounded-xl px-3 py-2 text-sm font-bold shadow-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950";
const buttonToneClass: Record<ButtonTone, string> = {
  neutral: "border border-slate-200 bg-white text-slate-800 hover:bg-slate-50",
  fold: "bg-[#f48b7d] text-slate-950 hover:bg-[#ef7868]",
  call: "bg-[#14a9e7] text-slate-950 hover:bg-[#0596d2]",
  bet: "bg-[#20c9b6] text-slate-950 hover:bg-[#10b49f]",
  allIn: "bg-[#ffdc32] text-slate-950 hover:bg-[#f6c915]",
};
function tableSeatSlots(game: GameSnapshot): ReadonlyArray<number | null> {
  const slots = Array<number | null>(10).fill(null);
  const viewer = game.players.find((player) => player.playerId === game.viewer.playerId);
  if (viewer === undefined) return slots;
  slots[viewer.seat] = 5;
  const opponents = game.players.filter((player) => player.playerId !== viewer.playerId).sort((left, right) => ((left.seat - viewer.seat + 10) % 10) - ((right.seat - viewer.seat + 10) % 10));
  const availableSlots = seatSlotsByOpponentCount[opponents.length] ?? seatSlotsByOpponentCount[9];
  opponents.forEach((player, index) => { slots[player.seat] = availableSlots[index] ?? null; });
  return slots;
}
function seatPosition(slot: number): CSSProperties {
  const position = tableSeatPositions[slot] ?? tableSeatPositions[0]!;
  return { "--seat-left": position.left, "--seat-top": position.top } as CSSProperties;
}
function subscribeNever(): () => void { return () => undefined; }
