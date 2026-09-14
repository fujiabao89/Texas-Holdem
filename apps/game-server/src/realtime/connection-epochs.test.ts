import { describe, expect, it } from "vitest";

import { createConnectionEpochRegistry } from "./connection-epochs";

describe("ConnectionEpochRegistry", () => {
  it("does not reuse an epoch after a normal disconnect and reconnect", () => {
    const epochs = createConnectionEpochRegistry();
    const firstEpoch = epochs.takeOver("room-1", "player-1");

    expect(epochs.release("room-1", "player-1", firstEpoch)).toBe(true);
    expect(epochs.isCurrent("room-1", "player-1", firstEpoch)).toBe(false);

    const reconnectedEpoch = epochs.takeOver("room-1", "player-1");
    expect(reconnectedEpoch).toBeGreaterThan(firstEpoch);
    expect(epochs.isCurrent("room-1", "player-1", firstEpoch)).toBe(false);
    expect(epochs.isCurrent("room-1", "player-1", reconnectedEpoch)).toBe(true);
  });

  it("forgets only the closed room and cannot revive an old epoch after reuse", () => {
    const epochs = createConnectionEpochRegistry();
    const first = epochs.takeOver("room-1", "player-1");
    const second = epochs.takeOver("room-1", "player-2");
    const other = epochs.takeOver("room-10", "player-1");
    epochs.forgetRoom("room-1");
    epochs.forgetRoom("room-1");
    epochs.forgetRoom("never-created");
    expect(epochs.isCurrent("room-1", "player-1", first)).toBe(false);
    expect(epochs.isCurrent("room-1", "player-2", second)).toBe(false);
    expect(epochs.isCurrent("room-10", "player-1", other)).toBe(true);
    expect(epochs.activeCount()).toBe(1);
    const reconnected = epochs.takeOver("room-1", "player-1");
    expect(reconnected).toBeGreaterThan(other);
    expect(epochs.release("room-1", "player-1", first)).toBe(false);
    expect(epochs.isCurrent("room-1", "player-1", reconnected)).toBe(true);
    epochs.forgetRoom("room-1");
    epochs.forgetRoom("room-10");
    expect(epochs.activeCount()).toBe(0);
  });

  it("keeps only active entries across repeated room lifecycles", () => {
    const epochs = createConnectionEpochRegistry();
    let previous = 0;
    for (let i = 0; i < 200; i++) {
      const roomId = `room-${i}`;
      const epoch = epochs.takeOver(roomId, "player");
      expect(epoch).toBeGreaterThan(previous);
      previous = epoch;
      expect(epochs.activeCount()).toBe(1);
      expect(epochs.release(roomId, "player", epoch)).toBe(true);
      epochs.forgetRoom(roomId);
      expect(epochs.activeCount()).toBe(0);
    }
  });
});
