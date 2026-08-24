import { atom } from "jotai";

/** Purely local presentation state. It deliberately has no reference to PlayerView. */
export const soundEnabledAtom = atom(true);
export const openPanelAtom = atom<string | null>(null);
export const commandFeedbackAtom = atom<string | null>(null);
