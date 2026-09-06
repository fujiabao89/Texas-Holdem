"use client";

import Link from "next/link";

import { message, messageList } from "../../messages/zh-CN";
import { presentationPreferences } from "../../state/presentation-preferences";
import { usePresentationPreferences } from "../../state/use-presentation-preferences";

export function SettingsPageContent() {
  const { soundEnabled, soundVolume, motion } = usePresentationPreferences();
  const volumePercent = Math.round(soundVolume * 100);

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
            aria-label={message("settings.soundSwitchLabel")}
            className={`relative inline-flex h-9 w-16 shrink-0 items-center rounded-full border transition focus-visible:outline-2 focus-visible:outline-offset-2 ${soundEnabled ? "border-emerald-700 bg-emerald-600" : "border-slate-300 bg-slate-200"}`}
            onClick={() => presentationPreferences.set({ soundEnabled: !soundEnabled })}
            role="switch"
            type="button"
          >
            <span aria-hidden="true" className={`ml-1 h-7 w-7 rounded-full bg-white shadow transition-transform ${soundEnabled ? "translate-x-7" : "translate-x-0"}`} />
          </button>
        </div>
        <div className="mt-6">
          <div className="flex items-center justify-between gap-4 text-sm">
            <label className="font-medium" htmlFor="sound-volume">{message("settings.volumeLabel")}</label>
            <output className="font-mono tabular-nums text-slate-600" htmlFor="sound-volume">{volumePercent}%</output>
          </div>
          <input
            aria-describedby="sound-volume-help"
            aria-valuetext={`${volumePercent}%`}
            className="mt-2 h-11 w-full cursor-pointer accent-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2"
            id="sound-volume"
            max={100}
            min={0}
            onChange={(event) => presentationPreferences.set({ soundVolume: Number(event.target.value) / 100 })}
            step={1}
            type="range"
            value={volumePercent}
          />
          <p className="text-xs leading-relaxed text-slate-500" id="sound-volume-help">{message("settings.volumeHelp")}</p>
        </div>
        <p className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500">
          {message("settings.audioCredit")} · {message("settings.audioLicense")}
        </p>
      </section>
      <section aria-labelledby="motion-heading" className="rounded-2xl border border-neutral-200 p-5 shadow-sm">
        <h2 id="motion-heading" className="font-semibold">{message("settings.motionTitle")}</h2>
        <label className="mt-3 block text-sm font-medium" htmlFor="motion-preference">{message("settings.motionLabel")}</label>
        <select
          aria-describedby="motion-help"
          className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
          id="motion-preference"
          onChange={(event) => presentationPreferences.set({ motion: event.target.value === "reduce" ? "reduce" : "system" })}
          value={motion}
        >
          <option value="system">{message("settings.motionSystem")}</option>
          <option value="reduce">{message("settings.motionReduce")}</option>
        </select>
        <p className="mt-3 text-sm leading-relaxed text-slate-600" id="motion-help">{message("settings.motionHelp")}</p>
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
