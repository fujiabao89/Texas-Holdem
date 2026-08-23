import type { Database } from "../database";
import { tournaments, tournamentPlayers } from "../schema";

/**
 * Tournament 控制面仓储（docs/03-data-model.md §5.3/§5.4/§7.2）。
 *
 * 只提供控制面最小原子写入：Tournament + 锁定参赛者快照在同一事务提交
 * （`last_committed_sequence = 0`，§7.2）；首个 Snapshot 在第 1 手完整提交时生成。
 * 开局校验（人数/Ready/座位分配策略）属运行时任务（TEX-19/TEX-20）。
 */

export interface TournamentPlayerSeed {
  readonly id: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly seatIndex: number;
  readonly kind: "HUMAN" | "BOT";
  readonly startingStack: bigint;
}

export interface CreateTournamentWithPlayersInput {
  readonly tournamentId: string;
  readonly roomId: string;
  readonly tournamentNo: number;
  /** 已通过服务端 Schema Validation 的 TournamentConfig 快照（§5.3）。 */
  readonly configJson: unknown;
  readonly players: readonly TournamentPlayerSeed[];
}

export interface TournamentRepository {
  /**
   * 单事务写入 Tournament（IN_GAME、last_committed_sequence=0）与全部
   * tournament_players 锁定快照；任一失败整体回滚，不留半开比赛。
   */
  createTournamentWithPlayers(input: CreateTournamentWithPlayersInput): Promise<void>;
}

export function createTournamentRepository(database: Database): TournamentRepository {
  async function createTournamentWithPlayers(
    input: CreateTournamentWithPlayersInput,
  ): Promise<void> {
    await database.withTransaction(async (tx) => {
      await tx.insert(tournaments).values({
        id: input.tournamentId,
        roomId: input.roomId,
        tournamentNo: input.tournamentNo,
        status: "IN_GAME",
        configJson: input.configJson,
        lastCommittedSequence: 0n,
      });
      await tx.insert(tournamentPlayers).values(
        input.players.map((player) => ({
          id: player.id,
          tournamentId: input.tournamentId,
          roomId: input.roomId,
          playerId: player.playerId,
          displayName: player.displayName,
          seatIndex: player.seatIndex,
          kind: player.kind,
          startingStack: player.startingStack,
          pokerStatus: "ACTIVE" as const,
        })),
      );
    });
  }

  return { createTournamentWithPlayers };
}
