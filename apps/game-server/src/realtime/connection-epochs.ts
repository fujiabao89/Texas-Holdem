/**
 * Connection epochs are transport-private authority tokens. They never cross the
 * wire: a newly authenticated socket advances its player's epoch, so work that
 * was queued by an older socket can be rejected at the Tournament executor.
 */
export interface ConnectionEpochRegistry {
  takeOver(roomId: string, playerId: string): number;
  isCurrent(roomId: string, playerId: string, epoch: number): boolean;
  release(roomId: string, playerId: string, epoch: number): boolean;
  /** Room CLOSED：同步撤销该房间的所有连接，不保留每玩家 generation 墓碑。 */
  forgetRoom(roomId: string): void;
  activeCount(): number;
}

export function createConnectionEpochRegistry(): ConnectionEpochRegistry {
  const activeEpochs = new Map<string, number>();
  let nextEpoch = 0;
  const keyOf = (roomId: string, playerId: string): string => `${roomId}:${playerId}`;

  return {
    takeOver(roomId, playerId) {
      const key = keyOf(roomId, playerId);
      // 全局单调序号允许完全清除旧成员记录，而迟到旧命令仍不可能匹配重连后的 epoch。
      if (nextEpoch >= Number.MAX_SAFE_INTEGER)
        throw new Error("Connection epoch capacity exhausted");
      const epoch = ++nextEpoch;
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
    forgetRoom(roomId) {
      const prefix = `${roomId}:`;
      for (const key of activeEpochs.keys()) {
        if (key.startsWith(prefix)) activeEpochs.delete(key);
      }
    },
    activeCount: () => activeEpochs.size,
  };
}
