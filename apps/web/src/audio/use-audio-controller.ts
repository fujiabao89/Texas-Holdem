"use client";

import { useAtom } from "jotai";
import { useEffect, useState } from "react";

import { soundEnabledAtom } from "../state/ui-state";
import { AudioController, createBrowserAudioAdapter } from "./audio-controller";

export function useAudioController(): readonly [AudioController, boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useAtom(soundEnabledAtom);
  const [controller] = useState(() => new AudioController(createBrowserAudioAdapter()));
  useEffect(() => { controller.setEnabled(enabled); }, [controller, enabled]);
  return [controller, enabled, setEnabled] as const;
}
