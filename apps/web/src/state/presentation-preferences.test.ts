import { describe, expect, it, vi } from "vitest";

import {
  createPresentationPreferencesStore,
  DEFAULT_PRESENTATION_PREFERENCES,
  PRESENTATION_STORAGE_KEYS as keys,
  type PreferenceEnvironment,
} from "./presentation-preferences";

function fakeEnvironment(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
  const listeners = new Set<(key: string | null) => void>();
  const environment: PreferenceEnvironment = {
    getStorage: () => storage,
    subscribeStorage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { values, storage, environment, listeners, emit: (key: string | null) => { for (const listener of listeners) listener(key); } };
}

describe("device presentation preferences", () => {
  it("keeps the server snapshot stable without touching browser storage", () => {
    const environment: PreferenceEnvironment = { getStorage: vi.fn(() => { throw new Error("no browser"); }), subscribeStorage: () => () => undefined };
    const preferences = createPresentationPreferencesStore(environment);
    expect(preferences.getServerSnapshot()).toBe(DEFAULT_PRESENTATION_PREFERENCES);
    expect(environment.getStorage).not.toHaveBeenCalled();
    expect(preferences.getSnapshot()).toBe(DEFAULT_PRESENTATION_PREFERENCES);
  });

  it("restores the legacy sound key even when the table is the first visited page", () => {
    const fake = fakeEnvironment({ [keys.soundEnabled]: "0", [keys.soundVolume]: "0.35", [keys.motion]: "reduce" });
    const preferences = createPresentationPreferencesStore(fake.environment);
    expect(preferences.getSnapshot()).toEqual({ soundEnabled: false, soundVolume: 0.35, motion: "reduce" });
    expect(preferences.getSnapshot()).toBe(preferences.getSnapshot());
    expect(preferences.getServerSnapshot()).toEqual({ soundEnabled: true, soundVolume: 0.8, motion: "system" });
  });

  it("persists writes and immediately notifies every same-page consumer", () => {
    const fake = fakeEnvironment();
    const preferences = createPresentationPreferencesStore(fake.environment);
    const table = vi.fn();
    const settings = vi.fn();
    const unsubscribeTable = preferences.subscribe(table);
    const unsubscribeSettings = preferences.subscribe(settings);
    preferences.set({ soundEnabled: false, soundVolume: 0.21, motion: "reduce" });
    expect(table).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledOnce();
    expect(fake.values.get(keys.soundEnabled)).toBe("0");
    expect(fake.values.get(keys.soundVolume)).toBe("0.21");
    expect(fake.values.get(keys.motion)).toBe("reduce");
    expect(createPresentationPreferencesStore(fake.environment).getSnapshot()).toEqual(preferences.getSnapshot());
    unsubscribeTable();
    expect(fake.listeners.size).toBe(1);
    unsubscribeSettings();
    expect(fake.listeners.size).toBe(0);
  });

  it("syncs cross-tab changes and clear, ignoring unrelated keys", () => {
    const fake = fakeEnvironment();
    const preferences = createPresentationPreferencesStore(fake.environment);
    const listener = vi.fn();
    preferences.subscribe(listener);
    fake.values.set(keys.soundEnabled, "0");
    fake.emit("unrelated");
    expect(listener).not.toHaveBeenCalled();
    fake.emit(keys.soundEnabled);
    expect(preferences.getSnapshot().soundEnabled).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    fake.values.clear();
    fake.emit(null);
    expect(preferences.getSnapshot()).toEqual(DEFAULT_PRESENTATION_PREFERENCES);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite another tab's sound setting when changing only volume", () => {
    const fake = fakeEnvironment();
    const preferences = createPresentationPreferencesStore(fake.environment);
    const listener = vi.fn();
    preferences.subscribe(listener);
    fake.values.set(keys.soundEnabled, "0");
    // Storage event may not have been delivered yet when the slider is moved.
    preferences.set({ soundVolume: 0.5 });
    expect(preferences.getSnapshot()).toMatchObject({ soundEnabled: false, soundVolume: 0.5 });
    expect(fake.storage.setItem).toHaveBeenCalledExactlyOnceWith(keys.soundVolume, "0.5");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("refreshes after unmount/remount, without leaking cross-tab listeners", () => {
    const fake = fakeEnvironment();
    const preferences = createPresentationPreferencesStore(fake.environment);
    const dispose = preferences.subscribe(vi.fn());
    dispose();
    fake.values.set(keys.motion, "reduce");
    const remounted = vi.fn();
    const disposeAgain = preferences.subscribe(remounted);
    expect(remounted).toHaveBeenCalledOnce();
    expect(preferences.getSnapshot().motion).toBe("reduce");
    disposeAgain();
    expect(fake.listeners.size).toBe(0);
  });

  it("keeps same-page settings functional when reading localStorage is denied", () => {
    const environment: PreferenceEnvironment = { getStorage: () => { throw new Error("SecurityError"); }, subscribeStorage: () => () => undefined };
    const preferences = createPresentationPreferencesStore(environment);
    const listener = vi.fn();
    preferences.subscribe(listener);
    expect(() => preferences.set({ soundEnabled: false, soundVolume: 0.4 })).not.toThrow();
    expect(preferences.getSnapshot()).toMatchObject({ soundEnabled: false, soundVolume: 0.4 });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("preserves memory edits after a quota failure instead of restoring stale storage", () => {
    const fake = fakeEnvironment({ [keys.soundEnabled]: "1" });
    fake.storage.setItem.mockImplementation(() => { throw new Error("QuotaExceededError"); });
    const preferences = createPresentationPreferencesStore(fake.environment);
    const unsubscribe = preferences.subscribe(vi.fn());
    preferences.set({ soundEnabled: false });
    unsubscribe();
    preferences.subscribe(vi.fn());
    preferences.set({ soundVolume: 0.2 });
    fake.emit(keys.soundEnabled);
    expect(preferences.getSnapshot()).toMatchObject({ soundEnabled: false, soundVolume: 0.2 });
  });

  it.each(["", "not-a-number", "NaN", "Infinity"])("defaults malformed stored volume %j", (value) => {
    const fake = fakeEnvironment({ [keys.soundVolume]: value, [keys.motion]: "allow-full-motion" });
    expect(createPresentationPreferencesStore(fake.environment).getSnapshot()).toEqual(DEFAULT_PRESENTATION_PREFERENCES);
  });

  it("bounds finite volume and preserves zero as intentional silence", () => {
    const fake = fakeEnvironment();
    const preferences = createPresentationPreferencesStore(fake.environment);
    preferences.set({ soundVolume: -2 });
    expect(preferences.getSnapshot().soundVolume).toBe(0);
    preferences.set({ soundVolume: 8 });
    expect(preferences.getSnapshot().soundVolume).toBe(1);
    preferences.set({ soundVolume: NaN });
    expect(preferences.getSnapshot().soundVolume).toBe(0.8);
  });
});
