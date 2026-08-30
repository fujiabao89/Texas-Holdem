"use client";

import { useAtom } from "jotai";
import { useEffect, useState } from "react";

import { soundEnabledAtom } from "../state/ui-state";
import { AudioController, createBrowserAudioAdapter, createExclusiveAudioChannel } from "./audio-controller";

const browserAudioChannel = createExclusiveAudioChannel();

export function useAudioController(): readonly [AudioController, boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useAtom(soundEnabledAtom);
  const [controller] = useState(() => new AudioController(createBrowserAudioAdapter(), undefined, browserAudioChannel));
  useEffect(() => { controller.setEnabled(enabled); }, [controller, enabled]);
  useEffect(() => {
    const updateForeground = () => controller.setForeground(document.visibilityState === "visible");
    updateForeground();
    document.addEventListener("visibilitychange", updateForeground);
    return () => {
      document.removeEventListener("visibilitychange", updateForeground);
      controller.setForeground(false);
    };
  }, [controller]);
  return [controller, enabled, setEnabled] as const;
}
