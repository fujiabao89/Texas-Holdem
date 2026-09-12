"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

import type { CreateRoomRequest, JoinRoomRequest } from "@texas-holdem/protocol";

import { errorMessage, formatMessage, message } from "../../messages/zh-CN";
import { useRoomClient } from "./room-client";
import { standardConfig, updateInitialBlind } from "./room-presets";

export function CreateRoomFlow() {
  const router = useRouter();
  const { http, projection, tokens } = useRoomClient();
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
    tokens.save(result.data.data.roomId, result.data.data.playerToken, result.data.data.playerId);
    router.push(`/room/${result.data.data.roomId}`);
  };
  return <RoomForm kind="create" title={message("room.createTitle")} onSubmit={submit} pending={pending} feedback={feedback}>
    <fieldset className="rr-form-group rr-form-group-single"><legend>{message("brand.identity")}</legend><TextField label={message("room.displayName")} value={displayName} onChange={setDisplayName} autoFocus /></fieldset>
    <fieldset className="rr-form-group"><legend>{message("brand.tableConfig")}</legend>
    <NumberField label={message("room.maxPlayers")} value={config.maxPlayers} min={2} max={10} onChange={(maxPlayers) => setConfig((current) => ({ ...current, maxPlayers }))} />
    <NumberField label={message("room.startingStack")} value={config.startingStack} min={1} onChange={(startingStack) => setConfig((current) => ({ ...current, startingStack }))} />
    <NumberField label={message("room.smallBlind")} value={config.smallBlind} min={1} onChange={(smallBlind) => setConfig((current) => updateInitialBlind(current, { smallBlind }))} />
    <NumberField label={message("room.bigBlind")} value={config.bigBlind} min={2} onChange={(bigBlind) => setConfig((current) => updateInitialBlind(current, { bigBlind }))} />
    </fieldset><fieldset className="rr-form-group"><legend>{message("brand.rhythm")}</legend>
    <SelectField label={message("room.actionTime")} value={String(config.actionTime)} onChange={(value) => setConfig((current) => ({ ...current, actionTime: value === "UNLIMITED" ? "UNLIMITED" : Number(value) as 15 | 20 | 30 | 45 | 60, timeBank: value === "UNLIMITED" ? 0 : current.timeBank }))} options={["15", "20", "30", "45", "60", "UNLIMITED"]} />
    {config.actionTime !== "UNLIMITED" && <SelectField label={message("room.timeBank")} value={String(config.timeBank)} onChange={(value) => setConfig((current) => ({ ...current, timeBank: Number(value) as 0 | 30 | 60 | 120 }))} options={["0", "30", "60", "120"]} />}
    </fieldset>
    <button className={primaryButton} disabled={pending} type="submit">{pending ? message("room.operationPending") : message("room.submitCreate")}</button>
  </RoomForm>;
}

export function JoinRoomFlow({ initialInviteCode }: { readonly initialInviteCode: string }) {
  const router = useRouter();
  const { http, projection, tokens } = useRoomClient();
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
    tokens.save(result.data.data.roomId, result.data.data.playerToken, result.data.data.playerId);
    router.push(`/room/${result.data.data.roomId}`);
  };
  return <RoomForm kind="join" title={message("room.joinTitle")} onSubmit={submit} pending={pending} feedback={feedback}>
    <TextField label={message("room.inviteCode")} value={inviteCode} onChange={setInviteCode} invite autoFocus />
    <TextField label={message("room.displayName")} value={displayName} onChange={setDisplayName} />
    <button className={primaryButton} disabled={pending} type="submit">{pending ? message("room.operationPending") : message("room.submitJoin")}</button>
  </RoomForm>;
}

function RoomForm({ kind, title, onSubmit, pending, feedback, children }: { readonly kind: "create" | "join"; readonly title: string; readonly onSubmit: (event: FormEvent) => void; readonly pending: boolean; readonly feedback: string | null; readonly children: ReactNode }) {
  return <main className="rr-page rr-form-layout">
    <aside className="rr-form-aside"><Link className="rr-nav-link text-sm" href="/">← {message("room.back")}</Link><h2>{message(kind === "create" ? "brand.createIntro" : "brand.joinIntro")}</h2><p className="rr-muted">{message(kind === "create" ? "brand.createDescription" : "brand.joinDescription")}</p><span className="rr-form-emblem" aria-hidden="true">{kind === "create" ? "♠" : "♦"}</span></aside>
    <section className="rr-panel"><header className="rr-form-header"><p className="rr-kicker">{message("brand.takeSeat")}</p><h1 className="rr-page-title">{title}</h1></header>
      <form className="rr-form-grid" onSubmit={onSubmit} aria-busy={pending}>{children}</form>
      {feedback !== null && <p className="rr-feedback rr-error mt-5" role="alert">{feedback}</p>}
    </section>
  </main>;
}

function TextField({ label, value, onChange, autoFocus = false, invite = false }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly autoFocus?: boolean; readonly invite?: boolean }) {
  return <label className="rr-field">{label}<input className={`${inputClass} ${invite ? "rr-input-code" : ""}`} value={value} autoFocus={autoFocus} autoComplete={invite ? "off" : "nickname"} autoCapitalize={invite ? "characters" : "none"} spellCheck={false} placeholder={message(invite ? "brand.codePlaceholder" : "brand.namePlaceholder")} required minLength={invite ? 6 : 2} maxLength={invite ? 6 : 16} onChange={(event) => onChange(invite ? event.target.value.toUpperCase() : event.target.value)} /></label>;
}

function NumberField({ label, value, min, max, onChange }: { readonly label: string; readonly value: number; readonly min: number; readonly max?: number; readonly onChange: (value: number) => void }) {
  return <label className="rr-field">{label}<input className={inputClass} type="number" value={value} min={min} max={max} required onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
function SelectField({ label, value, options, onChange }: { readonly label: string; readonly value: string; readonly options: readonly string[]; readonly onChange: (value: string) => void }) {
  return <label className="rr-field">{label}<select className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{option === "UNLIMITED" ? message("brand.unlimited") : option === "0" ? message("brand.off") : formatMessage("brand.seconds", { value: option })}</option>)}</select></label>;
}

function samePayload<T>(previous: T | undefined, current: T): boolean {
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(current);
}
const inputClass = "rr-input";
export const primaryButton = "rr-button rr-button-primary";
