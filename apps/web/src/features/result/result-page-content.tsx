"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { ErrorCode, GameSnapshot, TournamentResult } from "@texas-holdem/protocol";

import { errorMessage, formatMessage, message } from "../../messages/zh-CN";
import { useLobbyConnection, useRoomClient } from "../lobby/room-client";
import { HandHistoryDrawer } from "../hand-history/hand-history-drawer";
import { useRoomMutation } from "../lobby/use-room-mutation";
import { useProjectionState } from "../../state/use-projection-state";
import { canReopenLobby, resultAvailableFor, resultChampion, resultRows } from "./result-view";

const numberFormat = new Intl.NumberFormat("zh-CN");

export interface HttpResultError {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly traceId?: string;
  readonly reason?: "NETWORK" | "TIMEOUT" | "CANCELLED";
}

/**
 * Game Result page (docs/05 §6.6): server-authoritative rankings, champion and
 * final chips for the exact `tournamentId` in the URL.
 *
 * Supports fast in-memory snapshot display, as well as authoritative recovery
 * via GET /api/v1/tournaments/{tournamentId}/result upon page refresh or direct URL
 * access (TEX-54 / TEX-55).
 *
 * Reopening only prepares the next lobby; Lobby owns the separate start flow.
 */
export function ResultPageContent({ roomId, tournamentId }: { readonly roomId: string; readonly tournamentId: string }) {
  const { http, projection, tokens } = useRoomClient();
  const state = useProjectionState(projection);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Authoritative results recovered via HTTP (keyed by tournamentId)
  const [recoveredResults, setRecoveredResults] = useState<Record<string, GameSnapshot | TournamentResult>>({});
  const [error, setError] = useState<HttpResultError | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useLobbyConnection(roomId);

  // sessionStorage is client-only; keep SSR and hydration output identical.
  const isBrowser = useSyncExternalStore(subscribeNever, () => true, () => false);

  const room = state.room;
  const game = state.game;

  // Adjust state during render when route parameters change
  const [prevParams, setPrevParams] = useState({ roomId, tournamentId });
  if (prevParams.roomId !== roomId || prevParams.tournamentId !== tournamentId) {
    setPrevParams({ roomId, tournamentId });
    setError(null);
    setHistoryOpen(false);
  }

  // Matching snapshot from live projection (if present and FINISHED)
  const matchingSnapshot = resultAvailableFor(game, tournamentId) ? game : null;
  if (matchingSnapshot && !recoveredResults[tournamentId]) {
    setRecoveredResults((prev) => ({ ...prev, [tournamentId]: matchingSnapshot }));
  }

  const activeResult = recoveredResults[tournamentId] ?? matchingSnapshot;

  // Authoritative HTTP recovery when no in-memory snapshot exists
  useEffect(() => {
    if (!roomId || !tournamentId) return;
    if (activeResult) return;
    if (tokens.get(roomId) === null) return;

    const controller = new AbortController();
    let cancelled = false;

    const fetchResult = async () => {
      try {
        const res = await http.getTournamentResult(tournamentId, roomId, { signal: controller.signal });
        if (cancelled) return;
        if (res.ok) {
          setRecoveredResults((prev) => ({ ...prev, [tournamentId]: res.data.data }));
          setError(null);
        } else if (res.error.reason !== "CANCELLED") {
          setError(res.error);
        }
      } catch {
        // Abort or network error handled by HttpTransport
      }
    };

    void fetchResult();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [roomId, tournamentId, retryCount, http, tokens, activeResult]);

  if (!isBrowser) return <ResultFrame><p aria-live="polite">{message("result.loading")}</p></ResultFrame>;

  if (room !== null && room.roomId === roomId && room.status === "CLOSED") {
    return (
      <ResultFrame>
        <p role="alert">{message("result.roomClosed")}</p>
        <Link className="underline" href="/">{message("result.backHome")}</Link>
      </ResultFrame>
    );
  }

  if (tokens.get(roomId) === null) {
    return (
      <ResultFrame>
        <p role="alert">{message("result.missingSession")}</p>
        <Link className="underline" href="/join">{message("room.joinTitle")}</Link>
      </ResultFrame>
    );
  }

  if (error !== null && activeResult === null) {
    const isAuthError = error.code === "AUTH_FAILED" || error.code === "AUTH_REQUIRED";
    const isNotFinished = error.code === "TOURNAMENT_NOT_FINISHED";
    const isRetryable = error.retryable || error.code === "TOURNAMENT_RESULT_INCOMPLETE" || error.code === "RATE_LIMITED";

    return (
      <ResultFrame>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{message("result.title")}</h1>
          <nav className="flex flex-wrap gap-2" aria-label={message("result.title")}>
            <Link className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50" href={`/room/${roomId}`}>{message("result.backToLobby")}</Link>
            <Link className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50" href="/">{message("result.backHome")}</Link>
          </nav>
        </header>
        <ResultLobbyControls roomId={roomId} />
        <section aria-labelledby="error-heading" className="rr-panel">
          <h2 id="error-heading" className="font-semibold text-red-900">{message("result.loadFailed")}</h2>
          <p className="mt-2 text-sm text-red-700" role="alert">{errorMessage(error.code)}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            {isRetryable && (
              <button
                className="rr-button rr-button-secondary"
                onClick={() => {
                  setError(null);
                  setRetryCount((c) => c + 1);
                }}
                type="button"
              >
                {message("result.retry")}
              </button>
            )}
            {isAuthError && (
              <Link className="rr-button rr-button-primary" href="/join">
                {message("room.joinTitle")}
              </Link>
            )}
            {isNotFinished && (
              <Link className="rr-button rr-button-primary" href={`/room/${roomId}/table`}>
                {message("result.backToTable")}
              </Link>
            )}
            <Link className="rr-button rr-button-secondary" href={`/room/${roomId}`}>
              {message("result.backToLobby")}
            </Link>
          </div>
        </section>
      </ResultFrame>
    );
  }

  if (activeResult === null) {
    return <ResultFrame><p aria-live="polite">{message("result.loading")}</p></ResultFrame>;
  }

  const rows = resultRows(activeResult);
  const champ = resultChampion(activeResult);

  return (
    <ResultFrame>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{message("result.title")}</h1>
        <nav className="flex flex-wrap gap-2" aria-label={message("result.title")}>
          <Link className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50" href={`/room/${roomId}`}>{message("result.backToLobby")}</Link>
          <Link className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50" href="/">{message("result.backHome")}</Link>
        </nav>
      </header>

      {champ.hasChampion ? (
        <section aria-label={message("result.champion")} className="rr-champion">
          <p className="text-sm font-semibold text-amber-800">{message("result.champion")}</p>
          <p className="mt-1 text-xl font-bold text-amber-950">{champ.displayName}</p>
          <p className="mt-1 text-sm text-amber-900">{message("result.finalChips")}：{numberFormat.format(champ.finalChips)}</p>
        </section>
      ) : (
        <section aria-label={message("result.champion")} className="rr-champion">
          <p className="text-sm font-semibold text-amber-800">{message("result.champion")}</p>
          <p className="mt-1 text-xl font-bold text-amber-950">{message("result.noChampion")}</p>
        </section>
      )}

      <section aria-labelledby="rankings-heading" className="rr-panel">
        <h2 id="rankings-heading" className="font-semibold">{message("table.rankings")}</h2>
        <table className="mt-3 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-neutral-600">
              <th scope="col" className="py-2 pr-3 font-medium">{message("table.rankings")}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{message("room.displayName")}</th>
              <th scope="col" className="py-2 text-right font-medium">{message("result.finalChips")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-b border-neutral-100 last:border-0" key={row.playerId}>
                <td className="py-2 pr-3 font-semibold">
                  {row.tied ? formatMessage("result.tiedRank", { position: row.place }) : formatMessage("table.rank", { position: row.place })}
                </td>
                <td className="py-2 pr-3">{row.displayName}{row.champion ? ` · ${message("result.champion")}` : ""}</td>
                <td className="py-2 text-right font-mono">{numberFormat.format(row.finalChips)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <ResultLobbyControls roomId={roomId} />
      <button className="rr-button w-fit" type="button" onClick={() => setHistoryOpen(true)}>{message("history.open")}</button>
      {historyOpen && <HandHistoryDrawer key={tournamentId} roomId={roomId} tournamentId={tournamentId} playerNames={new Map(activeResult.players.map((player) => [player.playerId, player.displayName]))} onClose={() => setHistoryOpen(false)} />}

    </ResultFrame>
  );
}

function ResultFrame({ children }: { readonly children: React.ReactNode }) {
  return <main className="rr-page rr-results flex flex-col gap-6">{children}</main>;
}

function subscribeNever(): () => void { return () => undefined; }

/** Permissions always follow the current room, independently of the archived result. */
function ResultLobbyControls({ roomId }: { readonly roomId: string }) {
  const { projection, tokens, connectionState } = useRoomClient();
  const { room } = useProjectionState(projection);
  const router = useRouter();
  const { run, pending, feedback } = useRoomMutation(roomId);
  if (room === null || room.roomId !== roomId || room.status === "CLOSED") return null;
  const playerId = tokens.getPlayerId(roomId);
  const isHost = playerId !== null && room.hostPlayerId === playerId;
  const reopen = async () => {
    const current = projection.getSnapshot().room;
    if (current?.roomId !== roomId || !canReopenLobby(current.status, current.hostPlayerId === tokens.getPlayerId(roomId))) return;
    const accepted = await run({ type: "REOPEN_LOBBY" });
    if (accepted?.roomId === roomId && accepted.status === "LOBBY") router.push(`/room/${roomId}`);
  };
  return <section className="rr-panel" aria-label={message("result.nextRound")}>
    {canReopenLobby(room.status, isHost) ? <>
      <p>{message("result.reopenHint")}</p>
      <button className="rr-button rr-button-primary mt-3" type="button" disabled={pending || connectionState !== "CONNECTED"} onClick={() => void reopen()}>{pending ? message("room.operationPending") : message("result.reopenLobby")}</button>
    </> : room.status === "LOBBY" ? <>
      <p>{message("result.lobbyOpen")}</p>
      <Link className="rr-button mt-3" href={`/room/${roomId}`}>{message("result.backToLobby")}</Link>
    </> : <p>{message(room.status === "IN_GAME" ? "result.nextStarted" : "result.waitForHost")}</p>}
    <p className="mt-2 text-sm text-slate-600">{message(room.status === "LOBBY" ? "room.inviteAvailable" : "room.invitePaused")}</p>
    {room.status === "IN_GAME" && <Link className="rr-button mt-3" href={`/room/${roomId}/table`}>{message("result.backToTable")}</Link>}
    {connectionState !== "CONNECTED" && <p role="status">{message("room.disconnected")}</p>}
    {feedback !== null && <p className="rr-feedback" role="alert">{feedback}</p>}
  </section>;
}
