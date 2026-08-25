"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

import type { CreateRoomRequest, JoinRoomRequest } from "@texas-holdem/protocol";

import { errorMessage, message } from "../../messages/zh-CN";
import { useRoomClient } from "./room-client";
import { standardConfig, updateInitialBlind } from "./room-presets";

export function CreateRoomFlow() {
  const router = useRouter();
  const { http, projection } = useRoomClient();
  const [displayName, setDisplayName] = useState("");
  const [config, setConfig] = useState(standardConfig);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [retry, setRetry] = useState<{ readonly request: CreateRoomRequest; readonly idempotencyKey: string } | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true); setFeedback(null);
    const request = { displayName, config };
    let result;
    try {
      result = await http.createRoom(request, { idempotencyKey: retry !== null && samePayload(retry.request, request) ? retry.idempotencyKey : undefined });
    } catch {
      setFeedback(errorMessage("INVALID_MESSAGE"));
      return;
    } finally {
      setPending(false);
    }
    if (!result.ok) {
      setRetry(result.error.retryable && result.idempotencyKey !== undefined ? { request, idempotencyKey: result.idempotencyKey } : null);
      setFeedback(result.error.reason === "TIMEOUT" ? message("room.errorTimeout") : result.error.reason === "CANCELLED" ? message("room.errorCancelled") : errorMessage(result.error.code));
      return;
    }
    setRetry(null);
    projection.acceptRoomSnapshot(result.data.data.roomSnapshot);
    router.push(`/room/${result.data.data.roomId}`);
  };
  return <RoomForm title={message("room.createTitle")} onSubmit={submit} pending={pending} feedback={feedback}>
    <TextField label={message("room.displayName")} value={displayName} onChange={setDisplayName} autoFocus />
    <NumberField label={message("room.maxPlayers")} value={config.maxPlayers} min={2} max={10} onChange={(maxPlayers) => setConfig((current) => ({ ...current, maxPlayers }))} />
    <NumberField label={message("room.startingStack")} value={config.startingStack} min={1} onChange={(startingStack) => setConfig((current) => ({ ...current, startingStack }))} />
    <NumberField label={message("room.smallBlind")} value={config.smallBlind} min={1} onChange={(smallBlind) => setConfig((current) => updateInitialBlind(current, { smallBlind }))} />
    <NumberField label={message("room.bigBlind")} value={config.bigBlind} min={2} onChange={(bigBlind) => setConfig((current) => updateInitialBlind(current, { bigBlind }))} />
    <SelectField label={message("room.actionTime")} value={String(config.actionTime)} onChange={(value) => setConfig((current) => ({ ...current, actionTime: value === "UNLIMITED" ? "UNLIMITED" : Number(value) as 15 | 20 | 30 | 45 | 60, timeBank: value === "UNLIMITED" ? 0 : current.timeBank }))} options={["15", "20", "30", "45", "60", "UNLIMITED"]} />
    {config.actionTime !== "UNLIMITED" && <SelectField label={message("room.timeBank")} value={String(config.timeBank)} onChange={(value) => setConfig((current) => ({ ...current, timeBank: Number(value) as 0 | 30 | 60 | 120 }))} options={["0", "30", "60", "120"]} />}
    <button className={primaryButton} disabled={pending} type="submit">{pending ? message("room.operationPending") : message("room.submitCreate")}</button>
  </RoomForm>;
}

export function JoinRoomFlow({ initialInviteCode }: { readonly initialInviteCode: string }) {
  const router = useRouter();
  const { http, projection } = useRoomClient();
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [displayName, setDisplayName] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [retry, setRetry] = useState<{ readonly request: JoinRoomRequest; readonly idempotencyKey: string } | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setPending(true); setFeedback(null);
    const request = { inviteCode: inviteCode.toUpperCase(), displayName };
    let result;
    try {
      result = await http.joinRoom(request, { idempotencyKey: retry !== null && samePayload(retry.request, request) ? retry.idempotencyKey : undefined });
    } catch {
      setFeedback(errorMessage("INVALID_MESSAGE"));
      return;
    } finally {
      setPending(false);
    }
    if (!result.ok) {
      setRetry(result.error.retryable && result.idempotencyKey !== undefined ? { request, idempotencyKey: result.idempotencyKey } : null);
      setFeedback(result.error.reason === "TIMEOUT" ? message("room.errorTimeout") : result.error.reason === "CANCELLED" ? message("room.errorCancelled") : errorMessage(result.error.code));
      return;
    }
    setRetry(null);
    projection.acceptRoomSnapshot(result.data.data.roomSnapshot);
    router.push(`/room/${result.data.data.roomId}`);
  };
  return <RoomForm title={message("room.joinTitle")} onSubmit={submit} pending={pending} feedback={feedback}>
    <TextField label={message("room.inviteCode")} value={inviteCode} onChange={setInviteCode} autoFocus />
    <TextField label={message("room.displayName")} value={displayName} onChange={setDisplayName} />
    <button className={primaryButton} disabled={pending} type="submit">{pending ? message("room.operationPending") : message("room.submitJoin")}</button>
  </RoomForm>;
}

function RoomForm({ title, onSubmit, pending: _pending, feedback, children }: { readonly title: string; readonly onSubmit: (event: FormEvent) => void; readonly pending: boolean; readonly feedback: string | null; readonly children: ReactNode }) {
  return <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-6 bg-white p-5 text-neutral-900">
    <Link className="w-fit text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2" href="/">{message("room.back")}</Link>
    <h1 className="text-3xl font-bold">{title}</h1>
    <form className="grid gap-4" onSubmit={onSubmit} aria-busy={_pending}>{children}</form>
    {feedback !== null && <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900" role="alert">{feedback}</p>}
  </main>;
}

function TextField({ label, value, onChange, autoFocus = false }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly autoFocus?: boolean }) {
  return <label className="grid gap-1 text-sm font-medium">{label}<input className={inputClass} value={value} autoFocus={autoFocus} required minLength={2} maxLength={16} onChange={(event) => onChange(event.target.value)} /></label>;
}
function NumberField({ label, value, min, max, onChange }: { readonly label: string; readonly value: number; readonly min: number; readonly max?: number; readonly onChange: (value: number) => void }) {
  return <label className="grid gap-1 text-sm font-medium">{label}<input className={inputClass} type="number" value={value} min={min} max={max} required onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
function SelectField({ label, value, options, onChange }: { readonly label: string; readonly value: string; readonly options: readonly string[]; readonly onChange: (value: string) => void }) {
  return <label className="grid gap-1 text-sm font-medium">{label}<select className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function samePayload<T>(previous: T | undefined, current: T): boolean {
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(current);
}
const inputClass = "rounded-md border border-neutral-300 bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2";
export const primaryButton = "rounded-md bg-neutral-900 px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2";
