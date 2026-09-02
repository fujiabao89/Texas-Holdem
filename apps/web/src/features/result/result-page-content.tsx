"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSyncExternalStore } from "react";

import { errorMessage, formatMessage, message } from "../../messages/zh-CN";
import { useLobbyConnection, useRoomClient } from "../lobby/room-client";
import { useProjectionState } from "../../state/use-projection-state";
import { canPlayAgain, resultAvailableFor, resultRows, resultSnapshotUnreachable } from "./result-view";

const numberFormat = new Intl.NumberFormat("zh-CN");

/**
 * Game Result page (docs/05 §6.6): server-authoritative rankings, champion and
 * final chips for the exact `tournamentId` in the URL. "Play again" goes
 * through the existing host-only `POST /rooms/{roomId}/tournaments` flow — it
 * creates a brand-new tournament and never reuses finished-hand state.
 */
export function ResultPageContent({ roomId, tournamentId }: { readonly roomId: string; readonly tournamentId: string }) {
  const { http, projection, tokens } = useRoomClient();
  const state = useProjectionState(projection);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  useLobbyConnection(roomId);

  // sessionStorage is client-only; keep SSR and hydration output identical.
  const isBrowser = useSyncExternalStore(subscribeNever, () => true, () => false);
  if (!isBrowser) return <ResultFrame><p aria-live="polite">{message("result.loading")}</p></ResultFrame>;

  const room = state.room;
  const game = state.game;
  if (tokens.get(roomId) === null) return <ResultFrame><p role="alert">{message("result.missingSession")}</p><Link className="underline" href="/join">{message("room.joinTitle")}</Link></ResultFrame>;
  if (room !== null && room.roomId === roomId && room.status === "CLOSED") return <ResultFrame><p role="alert">{message("result.roomClosed")}</p><Link className="underline" href="/">{message("result.backHome")}</Link></ResultFrame>;
  // 房间已加载且无活跃比赛（FINISHED/LOBBY）：认证/重连只会带回 gameSnapshot:null，
  // 结果快照不会到达本连接——给出明确的不可用状态而不是永久 loading。
  if (resultSnapshotUnreachable(room, roomId, game)) return <ResultFrame><p role="alert">{message("result.snapshotUnavailable")}</p><Link className="underline" href={`/room/${roomId}`}>{message("result.backToLobby")}</Link></ResultFrame>;
  if (room === null || room.roomId !== roomId || game === null) return <ResultFrame><p aria-live="polite">{message("result.loading")}</p></ResultFrame>;
  if (!resultAvailableFor(game, tournamentId)) return <ResultFrame><p role="alert">{message("result.notFound")}</p><Link className="underline" href={`/room/${roomId}`}>{message("result.backToLobby")}</Link></ResultFrame>;

  const rows = resultRows(game);
  const playerId = tokens.getPlayerId(roomId);
  const isHost = playerId !== null && room.hostPlayerId === playerId;

  const playAgain = async () => {
    setPending(true);
    setFeedback(null);
    const result = await http.startTournament(roomId, { expectedRoomRevision: room.roomRevision });
    setPending(false);
    if (!result.ok) {
      setFeedback(errorMessage(result.error.code));
      return;
    }
    projection.acceptRoomSnapshot(result.data.data.roomSnapshot);
    router.push(`/room/${roomId}/table`);
  };

  return <ResultFrame>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold tracking-tight">{message("result.title")}</h1>
      <nav className="flex flex-wrap gap-2" aria-label={message("result.title")}>
        <Link className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50" href={`/room/${roomId}`}>{message("result.backToLobby")}</Link>
        <Link className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-slate-50" href="/">{message("result.backHome")}</Link>
      </nav>
    </header>
    {rows.filter((row) => row.champion).map((row) => (
      <section aria-label={message("result.champion")} className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm" key={row.playerId}>
        <p className="text-sm font-semibold text-amber-800">{message("result.champion")}</p>
        <p className="mt-1 text-xl font-bold text-amber-950">{row.displayName}</p>
        <p className="mt-1 text-sm text-amber-900">{message("result.finalChips")}：{numberFormat.format(row.finalChips)}</p>
      </section>
    ))}
    <section aria-labelledby="rankings-heading" className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
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
              <td className="py-2 pr-3 font-semibold">{row.tied ? formatMessage("result.tiedRank", { position: row.place }) : formatMessage("table.rank", { position: row.place })}</td>
              <td className="py-2 pr-3">{row.displayName}{row.champion ? ` · ${message("result.champion")}` : ""}</td>
              <td className="py-2 text-right font-mono">{numberFormat.format(row.finalChips)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
    {canPlayAgain(room.status, isHost) && (
      <section aria-labelledby="play-again-heading" className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 id="play-again-heading" className="font-semibold">{message("result.playAgain")}</h2>
        <p className="mt-1 text-sm text-slate-600">{message("room.startNeedPlayers")}</p>
        <button className="mt-3 min-h-11 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60" disabled={pending} onClick={() => void playAgain()} type="button">{pending ? message("room.operationPending") : message("result.playAgain")}</button>
      </section>
    )}
    {feedback !== null && <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900" role="alert">{feedback}</p>}
  </ResultFrame>;
}

function ResultFrame({ children }: { readonly children: React.ReactNode }) {
  return <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 bg-[#f7faf8] p-5 text-slate-900 sm:p-8">{children}</main>;
}

function subscribeNever(): () => void { return () => undefined; }
