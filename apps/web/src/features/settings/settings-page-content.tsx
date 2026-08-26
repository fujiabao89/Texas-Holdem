"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { useAtom } from "jotai";

import { message, messageList } from "../../messages/zh-CN";
import { soundEnabledAtom } from "../../state/ui-state";

/**
 * Global sound preference (docs/05 §6.7): a single device-level switch stored in
 * localStorage and exposed through the shared `soundEnabledAtom`. The audio
 * engine itself belongs to TEX-26; this page only owns the preference UI.
 */
const SOUND_STORAGE_KEY = "texas-holdem:sound-enabled";

const soundListeners = new Set<() => void>();

/**
 * The stored preference is read via useSyncExternalStore so SSR and the first
 * client render stay identical (docs/05 §17); the client snapshot replaces the
 * server default right after hydration without an effect-setState re-render.
 */
function subscribeSound(listener: () => void): () => void {
  soundListeners.add(listener);
  return () => soundListeners.delete(listener);
}

function readStoredSound(): boolean {
  return window.localStorage.getItem(SOUND_STORAGE_KEY) !== "0";
}

function writeStoredSound(next: boolean): void {
  window.localStorage.setItem(SOUND_STORAGE_KEY, next ? "1" : "0");
  for (const listener of soundListeners) listener();
}

export function SettingsPageContent() {
  const [, setSoundEnabled] = useAtom(soundEnabledAtom);
  const soundEnabled = useSyncExternalStore(subscribeSound, readStoredSound, () => true);

  const toggleSound = () => {
    const next = !soundEnabled;
    writeStoredSound(next);
    // Keep the shared preference atom (consumed by the future audio engine) in sync.
    setSoundEnabled(next);
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 bg-white p-6 text-slate-900 sm:p-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{message("settings.title")}</h1>
        <Link className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium shadow-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2" href="/">{message("shell.backHome")}</Link>
      </header>
      <section aria-labelledby="sound-heading" className="rounded-2xl border border-neutral-200 p-5 shadow-sm">
        <h2 id="sound-heading" className="font-semibold">{message("settings.soundTitle")}</h2>
        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="text-sm text-slate-600">{soundEnabled ? message("settings.soundEnabled") : message("settings.soundDisabled")}</p>
          <button
            aria-checked={soundEnabled}
            className={`relative inline-flex h-9 w-16 shrink-0 items-center rounded-full border transition focus-visible:outline-2 focus-visible:outline-offset-2 ${soundEnabled ? "border-emerald-700 bg-emerald-600" : "border-slate-300 bg-slate-200"}`}
            onClick={toggleSound}
            role="switch"
            type="button"
          >
            <span aria-hidden="true" className={`ml-1 h-7 w-7 rounded-full bg-white shadow transition-transform ${soundEnabled ? "translate-x-7" : "translate-x-0"}`} />
          </button>
        </div>
      </section>
      <section aria-labelledby="rules-heading" className="rounded-2xl border border-neutral-200 p-5 shadow-sm">
        <h2 id="rules-heading" className="font-semibold">{message("settings.rulesTitle")}</h2>
        <ol className="mt-3 grid gap-3 text-sm leading-relaxed text-slate-700">
          {messageList("settings.rules").map((paragraph) => <li className="rounded-xl bg-slate-50 p-3" key={paragraph}>{paragraph}</li>)}
        </ol>
      </section>
    </main>
  );
}
