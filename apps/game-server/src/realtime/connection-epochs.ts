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
  const activeEpochs = new Map<string, number>();
  const generations = new Map<string, number>();
  const keyOf = (roomId: string, playerId: string): string => `${roomId}:${playerId}`;

  return {
    takeOver(roomId, playerId) {
      const key = keyOf(roomId, playerId);
      const epoch = (generations.get(key) ?? 0) + 1;
      generations.set(key, epoch);
      activeEpochs.set(key, epoch);
      return epoch;
    },
    isCurrent(roomId, playerId, epoch) {
      return activeEpochs.get(keyOf(roomId, playerId)) === epoch;
    },
    release(roomId, playerId, epoch) {
      const key = keyOf(roomId, playerId);
      if (activeEpochs.get(key) !== epoch) return false;
      activeEpochs.delete(key);
      return true;
    },
  };
}
