import type { TournamentConfig } from "@texas-holdem/protocol";

const standardBlindStructure: TournamentConfig["blindStructure"] = [
  [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600],
  [400, 800], [600, 1_200], [800, 1_600], [1_000, 2_000], [1_500, 3_000],
  [2_000, 4_000], [3_000, 6_000], [5_000, 10_000], [7_500, 15_000],
  [10_000, 20_000], [15_000, 30_000],
].map(([smallBlind, bigBlind]) => ({ smallBlind, bigBlind, durationSeconds: 300 }));

/** docs/05 §6.2 的默认标准房间预设。 */
export const standardConfig: TournamentConfig = {
  maxPlayers: 6,
  startingStack: 10_000,
  smallBlind: 50,
  bigBlind: 100,
  blindMode: "time",
  blindStructure: standardBlindStructure,
  actionTime: 30,
  timeBank: 60,
};

/** 保留标准盲注表其余级别，仅同步 UI 可编辑的首级盲注。 */
export function updateInitialBlind(config: TournamentConfig, blind: Partial<Pick<TournamentConfig, "smallBlind" | "bigBlind">>): TournamentConfig {
  return {
    ...config,
    ...blind,
    blindStructure: config.blindStructure.map((level, index) => index === 0 ? { ...level, ...blind } : level),
  };
}
