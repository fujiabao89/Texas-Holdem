"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import type { Card, ErrorCode, GameSnapshot, SubmitAction } from "@texas-holdem/protocol";

import { clampWager, quickAmounts, wagerRange, wagerStep, type WagerRange } from "../betting/amounts";
import { errorMessage, formatMessage, message } from "../../messages/zh-CN";
import { useAudioController } from "../../audio/use-audio-controller";
import { useTablePresentation } from "../../animations/use-table-presentation";
import type { PresentationOverlay as PresentationOverlayState } from "../../animations/animation-queue";
import type { PendingCommand as TransportPendingCommand } from "../../protocol/websocket-transport";
import { useProjectionState } from "../../state/use-projection-state";
import { useLobbyConnection, useRoomClient } from "../lobby/room-client";
import { canSubmitTableAction, remainingTimeMs, tableSeats } from "./table-state";

type AmountMode = WagerRange["kind"] | null;
type TerminalError = Extract<ErrorCode, "AUTH_FAILED" | "UNSUPPORTED_PROTOCOL_VERSION" | "SESSION_REPLACED">;

export function PokerTablePage({ roomId }: { readonly roomId: string }) {
  const { projection, tokens, websocket, connectionState } = useRoomClient();
  const state = useProjectionState(projection);
  const presentation = useTablePresentation(projection, websocket);
  const [audio, soundEnabled, setSoundEnabled] = useAudioController();
  const [pending, setPending] = useState<TransportPendingCommand | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [retryCommand, setRetryCommand] = useState<TransportPendingCommand | null>(null);
  const [amountMode, setAmountMode] = useState<AmountMode>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [showExactInput, setShowExactInput] = useState(false);
  const [exactAmount, setExactAmount] = useState("");
  const [allInConfirmSequence, setAllInConfirmSequence] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<TerminalError | null>(null);
  const wasDisconnected = useRef(false);
  // sessionStorage is deliberately client-only. Keep SSR and hydration output
  // identical until React has switched to the browser snapshot.
  const isBrowser = useSyncExternalStore(subscribeNever, () => true, () => false);

  useLobbyConnection(roomId);

  useEffect(() => {
    const unlock = () => { void audio.unlock(); };
    window.addEventListener("pointerdown", unlock, { once: true });
    audio.preloadCritical();
    return () => window.removeEventListener("pointerdown", unlock);
  }, [audio]);

  useEffect(() => projection.subscribeAcceptedGameEvents((event) => audio.playEvent(event.message.payload.event)), [audio, projection]);

  useEffect(() => {
    if (connectionState !== "CONNECTED") wasDisconnected.current = true;
    else if (wasDisconnected.current) { wasDisconnected.current = false; setFeedback(message("table.reconnected")); }
  }, [connectionState]);

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

  return <TableFrame>
    <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-sm sm:px-5">
      <div><h1 className="text-xl font-bold tracking-tight text-slate-950 sm:text-2xl">{message("table.title")}</h1><p className="mt-0.5 text-sm text-slate-500">{message("table.handPhase")}：{phaseName(game.handPhase)}</p></div>
      <div className="flex items-center gap-2"><button className={buttonClass} aria-label={message("table.soundLabel")} aria-pressed={soundEnabled} onClick={() => { void audio.unlock(); setSoundEnabled(!soundEnabled); }}>{soundEnabled ? message("table.soundOn") : message("table.soundOff")}</button><ConnectionStatus connectionState={connectionState} syncing={state.actionsDisabled} /></div>
    </header>
    <section className="relative mx-auto w-full max-w-[1240px] py-10 sm:py-16" aria-label={message("table.title")}>
      <div className="relative mx-auto aspect-[1.06/1] w-full rounded-[46%] border-[10px] border-[#172029] bg-[#00795d] shadow-[0_22px_45px_rgba(10,45,35,0.22)] sm:aspect-[1.72/1] sm:border-[18px]">
        <div aria-hidden="true" className="absolute inset-[4%] rounded-[46%] border border-emerald-300/25 bg-[radial-gradient(ellipse_at_center,rgba(20,148,111,0.28),transparent_65%)]" />
        <p aria-hidden="true" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none whitespace-nowrap font-serif text-3xl font-semibold tracking-[0.2em] text-emerald-200/10 sm:text-6xl">TEXAS HOLD&apos;EM</p>
        <div className="absolute left-1/2 top-[31%] z-20 flex -translate-x-1/2 items-center gap-2 text-center sm:top-[34%]">
          <span className="rounded-full bg-emerald-100/35 px-2.5 py-1 text-[10px] font-semibold text-emerald-50 backdrop-blur sm:px-3 sm:text-xs">{phaseName(game.handPhase)}</span>
          <span className="rounded-full bg-amber-300/85 px-2.5 py-1 text-[10px] font-bold text-amber-950 shadow-sm sm:px-3 sm:text-xs">{message("table.pot")}：{game.pots.reduce((total, pot) => total + pot.amount, 0)}</span>
        </div>
        <div className="absolute left-1/2 top-1/2 z-20 w-[72%] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-emerald-100/10 bg-emerald-100/20 p-2.5 shadow-inner backdrop-blur-[1px] sm:w-auto sm:p-3" aria-label={message("table.board")}>
          <p className="sr-only">{message("table.board")}</p>
          <CommunityCards cards={game.board} />
        </div>
        <div className="absolute bottom-[8%] left-1/2 z-20 -translate-x-1/2 text-center text-[10px] font-medium text-emerald-100/75 sm:text-xs">
          <span>{message("table.currentActor")}：</span><span className="font-semibold text-white">{actorName(game) ?? message("table.waiting")}</span>
        </div>
        <div className="absolute inset-0 z-30" aria-label={message("room.seats")}>
          {tableSeats(game).map((player, seat) => <SeatCard game={game} room={state.room} player={player} seat={seat} slot={seatSlots[seat] ?? null} key={seat} />)}
        </div>
        {presentation.overlay !== null && <PresentationOverlay overlay={presentation.overlay} />}
      </div>
    </section>
    <section className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-x-4 gap-y-1 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-center shadow-sm" aria-labelledby="clock-heading"><h2 id="clock-heading" className="sr-only">{message("table.timeBank")}</h2><ClockStatus actionDeadline={state.clock?.actionDeadline ?? game.actionDeadline} timeBankMs={state.clock?.timeBankRemainingMs ?? game.viewer.timeBankRemainingMs} serverTime={state.clock?.serverTime ?? 0} clockKey={`${game.handId}:${game.currentActorPlayerId ?? "none"}`} /></section>
    {state.actionsDisabled && <p className="rounded bg-amber-50 p-3 text-sm" role="status">{message("table.syncing")}</p>}
    {connectionState !== "CONNECTED" && <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm" role="status" aria-live="polite">{message("table.reconnectingNotice")}</p>}
    {ownPokerStatus(state.room, canonicalGame.viewer.playerId) === "EXIT_PENDING" && <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm" role="status">{message("table.exitPendingNotice")}</p>}
    {ownPokerStatus(state.room, canonicalGame.viewer.playerId) === "WITHDRAWN" && <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm" role="status">{message("table.withdrawnNotice")}</p>}
    {legal !== null && <BettingControls game={canonicalGame} legal={legal} actionDeadline={state.clock?.actionDeadline ?? canonicalGame.actionDeadline} timeBankRemainingMs={state.clock?.timeBankRemainingMs ?? canonicalGame.viewer.timeBankRemainingMs} rangeForMode={rangeForMode} amount={amount} showExactInput={showExactInput} exactAmount={exactAmount} allInConfirm={allInConfirmSequence === canonicalGame.sequence} onAction={submit} onSelectMode={(mode) => { setAmountMode(mode); setAmount(range?.kind === mode ? range.min : null); setShowExactInput(false); setAllInConfirmSequence(null); }} onChooseAmount={chooseAmount} onExactChange={(value) => { setExactAmount(value); setAllInConfirmSequence(null); }} onToggleExact={() => setShowExactInput((value) => !value)} onSetAllInConfirm={(value) => setAllInConfirmSequence(value ? canonicalGame.sequence : null)} onUseTimeBank={() => { const command = websocket.prepareCommand({ type: "USE_TIME_BANK", payload: { tournamentId: canonicalGame.tournamentId, expectedSequence: canonicalGame.sequence } }); try { websocket.send(command); setPending(command); setFeedback(message("table.actionPending")); } catch { setFeedback(message("table.connectionDisconnected")); } }} />}
    {hasPendingCommand && <p aria-live="polite" className="text-sm text-neutral-600">{message("table.actionPending")}</p>}
    {feedback !== null && <p role="status" aria-live="polite" className="rounded border border-neutral-300 bg-neutral-50 p-3 text-sm">{feedback}</p>}
    {retryCommand !== null && <button className={buttonClass} disabled={connectionState !== "CONNECTED" || hasPendingCommand} onClick={retry}>{message("table.retry")}</button>}
    {canonicalGame.tournamentStatus === "FINISHED" && <RankingSummary game={canonicalGame} />}
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
  return <section className="relative z-20 mx-auto -mt-1 grid w-full max-w-xl gap-3 rounded-3xl border border-white/80 bg-white/95 p-3 shadow-[0_16px_35px_rgba(15,23,42,0.16)] backdrop-blur sm:p-4" aria-labelledby="actions-heading">
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

function SeatCard({ game, room, player, seat, slot }: { readonly game: GameSnapshot; readonly room: ReturnType<typeof useProjectionState>["room"]; readonly player: GameSnapshot["players"][number] | null; readonly seat: number; readonly slot: number | null }) {
  if (player === null || slot === null) return <span className="sr-only">{formatMessage("table.seat", { position: seat + 1 })}</span>;
  const viewer = player.playerId === game.viewer.playerId;
  const active = player.playerId === game.currentActorPlayerId;
  const cards = viewer ? game.viewer.holeCards : player.revealedCards;
  const connectionStatus = room?.players.find((roomPlayer) => roomPlayer.playerId === player.playerId)?.connectionStatus;
  const status = connectionStatus === "DISCONNECTED" ? message("table.disconnected") : player.pokerStatus === "ELIMINATED" ? message("table.eliminated") : player.pokerStatus === "EXIT_PENDING" ? message("table.exitPending") : player.pokerStatus === "WITHDRAWN" ? message("table.withdrawn") : null;
  return <article style={seatPosition(slot)} className="absolute z-30 w-[5.5rem] -translate-x-1/2 -translate-y-1/2 text-center sm:w-36" aria-label={`${player.displayName}，${formatMessage("table.seat", { position: seat + 1 })}${active ? `，${message("table.currentActor")}` : ""}`}>
    <div className="relative z-10 mx-auto -mb-1 flex min-h-8 justify-center sm:min-h-14">
      <CardRow cards={cards} hiddenCount={viewer ? Math.max(0, 2 - cards.length) : player.hasHoleCards ? Math.max(0, 2 - cards.length) : 0} variant={viewer ? "hole" : "seat"} />
    </div>
    <div className={`relative rounded-xl border px-1.5 py-1.5 shadow-lg sm:rounded-2xl sm:px-3 sm:py-2 ${active ? "border-amber-300 bg-[#315d37] ring-2 ring-amber-300/75" : "border-slate-700 bg-[#092a35]"}`}>
      {player.seat === game.dealerSeat && <span aria-label={message("table.dealer")} className="absolute -left-2 -top-2 grid h-5 w-5 place-items-center rounded-full border-2 border-white bg-slate-950 text-[9px] font-bold text-white shadow">D</span>}
      <strong className="block truncate text-[10px] font-semibold text-white sm:text-sm">{player.displayName}</strong>
      <span className="mt-0.5 block font-mono text-[9px] font-semibold text-emerald-300 sm:text-xs">{player.stack}</span>
    </div>
    {(player.streetBet > 0 || status !== null) && <div className="mt-1 flex flex-col items-center gap-0.5"><span className="rounded-full bg-[#004b38] px-1.5 py-0.5 text-[8px] font-semibold text-amber-200 shadow sm:px-2 sm:text-[10px]">{player.streetBet > 0 ? `${message("table.streetBet")} ${player.streetBet}` : status}</span>{player.streetBet > 0 && status !== null && <span className="text-[8px] font-medium text-emerald-100 sm:text-[10px]">{status}</span>}</div>}
  </article>;
}

function CommunityCards({ cards }: { readonly cards: readonly Card[] }) {
  return <div className="grid grid-cols-5 gap-1.5 sm:gap-2">{Array.from({ length: 5 }, (_, index) => {
    const card = cards[index];
    return card === undefined ? <span aria-hidden="true" className="h-16 w-12 rounded-lg border-2 border-dashed border-emerald-200/15 bg-emerald-950/10 sm:h-24 sm:w-[4.3rem]" key={`empty-${index}`} /> : <CardFace card={card} variant="board" key={`${card.rank}-${card.suit}-${index}`} />;
  })}</div>;
}

function CardRow({ cards, hiddenCount = 0, variant = "seat" }: { readonly cards: readonly Card[]; readonly hiddenCount?: number; readonly variant?: "seat" | "hole" }) {
  if (cards.length === 0 && hiddenCount === 0) return null;
  const fan = variant === "hole" ? "first:-rotate-6 last:rotate-6" : "first:-rotate-3 last:rotate-3";
  const spacing = variant === "hole" ? "-space-x-5 sm:-space-x-7" : "-space-x-3 sm:-space-x-5";
  return <div className={`flex justify-center ${spacing}`}>{cards.map((card, index) => <CardFace card={card} variant={variant} className={fan} key={`${card.rank}-${card.suit}-${index}`} />)}{Array.from({ length: hiddenCount }, (_, index) => <CardBack variant={variant} className={fan} key={`hidden-${index}`} />)}</div>;
}

function CardFace({ card, variant, className = "" }: { readonly card: Card; readonly variant: "board" | "seat" | "hole"; readonly className?: string }) {
  const red = card.suit === "DIAMONDS" || card.suit === "HEARTS";
  const dimensions = cardDimensions(variant);
  const cornerText = variant === "seat" ? "text-[8px] sm:text-xs" : "text-[10px] sm:text-sm";
  const color = red ? "text-rose-600" : "text-slate-900";
  return <span className={`relative block ${dimensions} ${className} shrink-0 overflow-hidden rounded-[0.45rem] border border-slate-200 bg-[linear-gradient(135deg,#ffffff,#f6f8fb)] font-serif font-bold shadow-[0_3px_7px_rgba(15,23,42,0.24)] ${color}`} aria-label={cardName(card)}>
    <CardCorner rank={card.rank} suit={cardSuit(card)} className={`left-[10%] top-[8%] ${cornerText}`} />
    <CardPips card={card} variant={variant} />
    <CardCorner rank={card.rank} suit={cardSuit(card)} className={`bottom-[8%] right-[10%] rotate-180 ${cornerText}`} />
  </span>;
}

function CardBack({ variant, className = "" }: { readonly variant: "seat" | "hole"; readonly className?: string }) {
  return <span className={`relative grid ${cardDimensions(variant)} ${className} shrink-0 place-items-center overflow-hidden rounded-[0.45rem] border border-blue-100/70 bg-[#1f4698] shadow-[0_3px_7px_rgba(15,23,42,0.24)]`} aria-label={message("table.hiddenCard")}>
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
function PresentationOverlay({ overlay }: { readonly overlay: PresentationOverlayState }) {
  const text = overlay.kind === "DEAL" ? message("table.animationDeal") : overlay.kind === "BURN" ? message("table.animationBurn") : overlay.kind === "BOARD" ? message("table.animationBoard") : overlay.kind === "WAGER" ? message("table.animationWager") : overlay.kind === "FOLD" ? message("table.animationFold") : overlay.kind === "SHOWDOWN" ? message("table.animationShowdown") : overlay.kind === "POT_AWARD" ? message("table.animationPotAward") : overlay.kind === "ELIMINATION" ? message("table.animationElimination") : message("table.animationFinish");
  return <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center" aria-live="polite"><div className="grid justify-items-center gap-2"><span className="animate-pulse rounded-full bg-slate-950/80 px-3 py-1.5 text-xs font-semibold text-white shadow-lg">{overlay.burnCardBackOnly ? "🂠" : ""} {text}</span>{overlay.bestFiveCards.length > 0 && <div className="flex gap-1 rounded-xl bg-slate-950/75 p-1.5">{overlay.bestFiveCards.map((card, index) => <CardFace card={card} variant="seat" className="ring-2 ring-amber-300" key={`${card.rank}-${card.suit}-${index}`} />)}</div>}</div></div>;
}
function RankingSummary({ game }: { readonly game: GameSnapshot }) { const players = new Map(game.players.map((player) => [player.playerId, player.displayName])); return <section aria-labelledby="rankings-heading" className="mx-auto w-full max-w-xl rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm"><h2 id="rankings-heading" className="font-semibold">{message("table.tournamentFinished")}</h2><ol className="mt-2 list-decimal pl-5">{game.rankings.map((ranking) => <li key={ranking.playerId}>{players.get(ranking.playerId) ?? message("table.player")} · {formatMessage("table.rank", { position: ranking.placement.from })}</li>)}</ol></section>; }
type ButtonTone = "neutral" | "fold" | "call" | "bet" | "allIn";
function ActionButton({ label, onClick, disabled = false, ariaLabel, tone = "neutral" }: { readonly label: string; readonly onClick: () => void; readonly disabled?: boolean; readonly ariaLabel?: string; readonly tone?: ButtonTone }) { return <button aria-label={ariaLabel} className={`${actionButtonClass} ${buttonToneClass[tone]}`} disabled={disabled} onClick={onClick}>{label}</button>; }
function TableFrame({ children }: { readonly children: ReactNode }) { return <main className="mx-auto flex min-h-screen w-full max-w-[1440px] flex-col gap-4 bg-[#f7faf8] p-3 text-slate-900 sm:gap-5 sm:p-6">{children}</main>; }
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
function seatPosition(slot: number): CSSProperties { return tableSeatPositions[slot] ?? tableSeatPositions[0]!; }
function subscribeNever(): () => void { return () => undefined; }
