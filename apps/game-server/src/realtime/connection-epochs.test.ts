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
});
