/** Device-only preferences; this store never reads or writes game projections. */
export interface PresentationPreferences {
  readonly soundEnabled: boolean;
  readonly soundVolume: number;
  readonly motion: "system" | "reduce";
}

export const DEFAULT_PRESENTATION_PREFERENCES: PresentationPreferences = Object.freeze({
  soundEnabled: true,
  soundVolume: 0.8,
  motion: "system",
});

export const PRESENTATION_STORAGE_KEYS = {
  soundEnabled: "texas-holdem:sound-enabled",
  soundVolume: "texas-holdem:sound-volume",
  motion: "texas-holdem:motion",
} as const;

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PreferenceEnvironment {
  getStorage(): PreferenceStorage | null;
  subscribeStorage(listener: (key: string | null) => void): () => void;
}

export function normalizeSoundVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.8;
}

const browserEnvironment: PreferenceEnvironment = {
  getStorage: () => typeof window === "undefined" ? null : window.localStorage,
  subscribeStorage(listener) {
    if (typeof window === "undefined") return () => undefined;
    const onStorage = (event: StorageEvent): void => {
      // Ignore sessionStorage, whose keys may be unrelated to device settings.
      try {
        if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
      } catch { return; }
      listener(event.key);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  },
};

/**
 * Cached snapshots make useSyncExternalStore hydration safe. Storage denial or
 * quota failure falls back to memory for this page's lifetime, including writes.
 * Independent keys prevent a volume edit from overwriting another tab's mute.
 */
export function createPresentationPreferencesStore(environment: PreferenceEnvironment = browserEnvironment) {
  let current = DEFAULT_PRESENTATION_PREFERENCES;
  let initialized = false;
  let storageFailed = false;
  const listeners = new Set<() => void>();
  let unsubscribeStorage: (() => void) | undefined;

  const publish = (next: PresentationPreferences): boolean => {
    if (next.soundEnabled === current.soundEnabled && next.soundVolume === current.soundVolume && next.motion === current.motion) return false;
    current = Object.freeze(next);
    return true;
  };
  const notify = (): void => { for (const listener of listeners) listener(); };
  const refresh = (): boolean => {
    if (storageFailed) return false;
    try {
      const storage = environment.getStorage();
      if (storage === null) return false;
      const rawVolume = storage.getItem(PRESENTATION_STORAGE_KEYS.soundVolume);
      const parsedVolume = rawVolume === null || rawVolume.trim() === "" ? 0.8 : Number(rawVolume);
      const next = {
        soundEnabled: storage.getItem(PRESENTATION_STORAGE_KEYS.soundEnabled) !== "0",
        soundVolume: normalizeSoundVolume(parsedVolume),
        motion: storage.getItem(PRESENTATION_STORAGE_KEYS.motion) === "reduce" ? "reduce" : "system",
      } as const;
      initialized = true;
      return publish(next);
    } catch {
      initialized = true;
      storageFailed = true;
      return false;
    }
  };

  return {
    getSnapshot(): PresentationPreferences {
      if (!initialized) refresh();
      return current;
    },
    getServerSnapshot: (): PresentationPreferences => DEFAULT_PRESENTATION_PREFERENCES,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        unsubscribeStorage = environment.subscribeStorage((key) => {
          if (key === null || Object.values(PRESENTATION_STORAGE_KEYS).some((known) => known === key)) {
            if (refresh()) notify();
          }
        });
        if (refresh()) notify();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeStorage?.();
          unsubscribeStorage = undefined;
        }
      };
    },
    set(patch: Partial<PresentationPreferences>): void {
      // Pick up changes made while the last UI consumer was unmounted.
      const refreshed = refresh();
      const next: PresentationPreferences = {
        soundEnabled: patch.soundEnabled ?? current.soundEnabled,
        soundVolume: patch.soundVolume === undefined ? current.soundVolume : normalizeSoundVolume(patch.soundVolume),
        motion: patch.motion === undefined ? current.motion : patch.motion === "reduce" ? "reduce" : "system",
      };
      const changed = publish(next);
      if (!storageFailed) {
        try {
          const storage = environment.getStorage();
          if (patch.soundEnabled !== undefined) storage?.setItem(PRESENTATION_STORAGE_KEYS.soundEnabled, next.soundEnabled ? "1" : "0");
          if (patch.soundVolume !== undefined) storage?.setItem(PRESENTATION_STORAGE_KEYS.soundVolume, String(next.soundVolume));
          if (patch.motion !== undefined) storage?.setItem(PRESENTATION_STORAGE_KEYS.motion, next.motion);
        } catch { storageFailed = true; }
      }
      if (changed || refreshed) notify();
    },
  };
}

export const presentationPreferences = createPresentationPreferencesStore();
