"use client";

import { useEffect, useState } from "react";

import { presentationPreferences } from "../state/presentation-preferences";
import { usePresentationPreferences } from "../state/use-presentation-preferences";
import { AudioController, createBrowserAudioAdapter, createExclusiveAudioChannel } from "./audio-controller";

const browserAudioChannel = createExclusiveAudioChannel();
const setSoundEnabled = (soundEnabled: boolean): void => presentationPreferences.set({ soundEnabled });

export function useAudioController(): readonly [AudioController, boolean, (enabled: boolean) => void] {
  const { soundEnabled } = usePresentationPreferences();
  const [controller] = useState(() => new AudioController(createBrowserAudioAdapter(), undefined, browserAudioChannel));
  useEffect(() => {
    controller.activate();
    const updatePreferences = (): void => {
      const preferences = presentationPreferences.getSnapshot();
      controller.setEnabled(preferences.soundEnabled);
      controller.setVolume(preferences.soundVolume);
    };
    updatePreferences();
    const unsubscribePreferences = presentationPreferences.subscribe(updatePreferences);
    const updateForeground = () => controller.setForeground(document.visibilityState === "visible");
    const unlock = (): void => { void controller.unlock(); };
    const unlockFromKeyboard = (event: KeyboardEvent): void => {
      if (!event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) unlock();
    };
    updateForeground();
    document.addEventListener("visibilitychange", updateForeground);
    document.addEventListener("pointerdown", unlock, { passive: true });
    document.addEventListener("keydown", unlockFromKeyboard);
    const cancelPreload = scheduleAudioPreload(() => controller.preloadCritical());
    return () => {
      unsubscribePreferences();
      cancelPreload();
      document.removeEventListener("visibilitychange", updateForeground);
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlockFromKeyboard);
      controller.dispose();
    };
  }, [controller]);
  return [controller, soundEnabled, setSoundEnabled] as const;
}

/** Avoid loading every sound on first render or leaving an idle job on unmount. */
function scheduleAudioPreload(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout: 2_000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, 600);
  return () => window.clearTimeout(handle);
}
