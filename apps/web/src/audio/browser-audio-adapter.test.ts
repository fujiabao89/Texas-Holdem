import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeClock } from "../../../../tests/support/fake-clock";
import { AudioController, createBrowserAudioAdapter } from "./audio-controller";

function installAudioMock() {
  const elements: FakeAudio[] = [];
  class FakeAudio {
    preload = "";
    muted = false;
    volume = 1;
    playbackRate = 1;
    preservesPitch = true;
    currentTime = 9;
    readonly listeners = new Map<string, Set<() => void>>();
    readonly pause = vi.fn();
    readonly load = vi.fn();
    readonly play = vi.fn(async (): Promise<void> => undefined);
    readonly removeAttribute = vi.fn((name: string) => { if (name === "src") this.src = ""; });

    constructor(public src: string) { elements.push(this); }
    addEventListener(type: string, listener: () => void): void {
      const listeners = this.listeners.get(type) ?? new Set<() => void>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: () => void): void { this.listeners.get(type)?.delete(listener); }
    emit(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
    listenerCount(): number { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
  }
  vi.stubGlobal("Audio", FakeAudio);
  const clock = createFakeClock();
  return { elements, clock, adapter: createBrowserAudioAdapter(clock) };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("browser audio lifecycle", () => {
  it("lazily reuses local elements, resolves at sound end and applies live volume", async () => {
    const { adapter, elements, clock } = installAudioMock();
    expect(elements).toHaveLength(0);
    adapter.preload?.(["/audio/card.mp3", "/audio/card.mp3"]);
    expect(elements).toHaveLength(1);
    const card = elements[0]!;
    const ended = vi.fn();
    const first = adapter.play("/audio/card.mp3", { volume: 0.35, playbackRate: 1.2 }).then(ended);
    await Promise.resolve();
    expect(ended).not.toHaveBeenCalled();
    expect(card).toMatchObject({ preload: "auto", currentTime: 0, volume: 0.35, playbackRate: 1.2, preservesPitch: false });
    adapter.setVolume?.(0.2);
    expect(card.volume).toBe(0.2);
    card.emit("ended");
    await first;
    expect(ended).toHaveBeenCalledOnce();
    expect(card.listenerCount()).toBe(0);
    expect(clock.pendingTimers()).toBe(0);

    const second = adapter.play("/audio/card.mp3");
    expect(elements).toHaveLength(1);
    expect(card).toMatchObject({ volume: 0.8, playbackRate: 1 });
    card.emit("ended");
    await second;
  });

  it("preempts the previous element and ignores its late play rejection", async () => {
    const { adapter, elements, clock } = installAudioMock();
    adapter.preload?.(["/audio/card.mp3"]);
    let rejectOld: (error: Error) => void = () => undefined;
    const card = elements[0]!;
    card.play.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
    const first = adapter.play("/audio/card.mp3");
    const secondEnded = vi.fn();
    const second = adapter.play("/audio/card.mp3").then(secondEnded);
    await first;
    rejectOld(new Error("previous playback aborted"));
    await Promise.resolve();
    expect(secondEnded).not.toHaveBeenCalled();
    expect(card.listenerCount()).toBe(2);
    expect(clock.pendingTimers()).toBe(1);
    card.emit("ended");
    await second;
    expect(clock.pendingTimers()).toBe(0);
  });

  it.each(["error-event", "rejected-play", "throwing-play"])("cleans handlers and timeouts after %s", async (failure) => {
    const { adapter, elements, clock } = installAudioMock();
    adapter.preload?.(["/audio/missing.mp3"]);
    const audio = elements[0]!;
    if (failure === "rejected-play") audio.play.mockRejectedValueOnce(new Error("missing asset"));
    if (failure === "throwing-play") audio.play.mockImplementationOnce(() => { throw new Error("detached element"); });
    const failed = expect(adapter.play("/audio/missing.mp3")).rejects.toBeInstanceOf(Error);
    if (failure === "error-event") audio.emit("error");
    await failed;
    expect(audio.listenerCount()).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
    const recovery = adapter.play("/audio/missing.mp3");
    audio.emit("ended");
    await recovery;
    expect(clock.pendingTimers()).toBe(0);
  });

  it("bounds suspended media and releases its listeners even when pausing fails", async () => {
    const { adapter, elements, clock } = installAudioMock();
    adapter.preload?.(["/audio/stalled.mp3"]);
    const audio = elements[0]!;
    audio.play.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const failed = expect(adapter.play("/audio/stalled.mp3")).rejects.toThrow("timed out");
    audio.pause.mockImplementationOnce(() => { throw new Error("detached"); });
    clock.advance(5_000);
    await failed;
    expect(audio.listenerCount()).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("unlocks within the gesture, silences the probe and can retry a denied or stalled attempt", async () => {
    const { adapter, elements, clock } = installAudioMock();
    adapter.preload?.(["/audio/kenney-impact-table-double-knock.mp3"]);
    const probe = elements[0]!;
    probe.play.mockRejectedValueOnce(Object.assign(new Error("autoplay"), { name: "NotAllowedError" }));
    const denied = expect(adapter.unlock()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(probe.play).toHaveBeenCalledOnce();
    expect(probe.muted).toBe(true);
    await denied;
    expect(probe.muted).toBe(false);
    expect(clock.pendingTimers()).toBe(0);

    probe.play.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const stalled = expect(adapter.unlock()).rejects.toThrow("timed out");
    clock.advance(5_000);
    await stalled;
    await adapter.unlock();
    expect(probe.play).toHaveBeenCalledTimes(3);
    expect(probe).toMatchObject({ muted: false, currentTime: 0 });
    expect(clock.pendingTimers()).toBe(0);
  });

  it("disposes media resources and can reuse the adapter after Strict Mode cleanup", async () => {
    const { adapter, elements, clock } = installAudioMock();
    const first = adapter.play("/audio/card.mp3");
    const old = elements[0]!;
    adapter.dispose?.();
    adapter.dispose?.();
    await first;
    expect(old.listenerCount()).toBe(0);
    expect(old.src).toBe("");
    expect(old.load).toHaveBeenCalledOnce();
    expect(clock.pendingTimers()).toBe(0);

    const next = adapter.play("/audio/card.mp3");
    expect(elements).toHaveLength(2);
    old.emit("ended");
    expect(elements[1]!.listenerCount()).toBe(2);
    elements[1]!.emit("ended");
    await next;
    expect(clock.pendingTimers()).toBe(0);
  });

  it("cancels pending unlock during dispose so its old completion cannot revive a remount", async () => {
    const { adapter, elements, clock } = installAudioMock();
    adapter.preload?.(["/audio/kenney-impact-table-double-knock.mp3"]);
    let finishOld: () => void = () => undefined;
    const old = elements[0]!;
    old.play.mockImplementationOnce(() => new Promise<void>((resolve) => { finishOld = resolve; }));
    const controller = new AudioController(adapter, clock);
    const oldUnlock = controller.unlock();
    controller.dispose();
    await oldUnlock;
    controller.activate();
    await controller.unlock();
    const current = elements[1]!;
    controller.playEvent({ type: "PLAYER_CHECKED", payload: { playerId: "p", seat: 0, source: "HUMAN_SOCKET" } });
    const pauseCount = current.pause.mock.calls.length;
    finishOld();
    await Promise.resolve();
    expect(current.pause).toHaveBeenCalledTimes(pauseCount);
    expect(current.listenerCount()).toBe(2);
    controller.dispose();
    expect(elements.every((element) => element.listenerCount() === 0 && element.src === "")).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
  });
});
