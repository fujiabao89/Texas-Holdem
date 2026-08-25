/**
 * Connection epochs are transport-private authority tokens. They never cross the
 * wire: a newly authenticated socket advances its player's epoch, so work that
 * was queued by an older socket can be rejected at the Tournament executor.
 */
export interface ConnectionEpochRegistry {
  takeOver(roomId: string, playerId: string): number;
  isCurrent(roomId: string, playerId: string, epoch: number): boolean;
  release(roomId: string, playerId: string, epoch: number): boolean;
}

export function createConnectionEpochRegistry(): ConnectionEpochRegistry {
  const epochs = new Map<string, number>();
  const keyOf = (roomId: string, playerId: string): string => `${roomId}:${playerId}`;

  return {
    takeOver(roomId, playerId) {
      const key = keyOf(roomId, playerId);
      const epoch = (epochs.get(key) ?? 0) + 1;
      epochs.set(key, epoch);
      return epoch;
    },
    isCurrent(roomId, playerId, epoch) {
      return epochs.get(keyOf(roomId, playerId)) === epoch;
    },
    release(roomId, playerId, epoch) {
      const key = keyOf(roomId, playerId);
      if (epochs.get(key) !== epoch) return false;
      epochs.delete(key);
      return true;
    },
  };
}
