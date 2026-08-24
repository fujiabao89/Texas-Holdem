/**
 * TournamentStarter port（docs/04-game-server-architecture.md §5.7）。
 *
 * TEX-19 只负责"开局原子锁定"：Room 队列确认开局条件后调用本 port 创建
 * Tournament 记录并把 Room 置为 IN_GAME。TEX-20 将注入真正的 Tournament
 * 运行时（Hand 循环、Timer、事件序列）；默认持久化实现仅落库，不实现
 * Hand/Tournament 运行时，也绝不伪造 Engine 结果。
 */

import type { TournamentConfig } from "@texas-holdem/protocol";
import type { RoomRepository } from "../infrastructure/persistence/repositories";

export interface TournamentPlayerSeed {
  readonly id: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly seatIndex: number;
  readonly kind: "HUMAN" | "BOT";
  readonly startingStack: bigint;
}

export interface TournamentStartRequest {
  readonly roomId: string;
  readonly tournamentId: string;
  readonly tournamentNo: number;
  readonly config: TournamentConfig;
  readonly players: readonly TournamentPlayerSeed[];
}

export interface TournamentStarter {
  start(request: TournamentStartRequest): Promise<void>;
}

/** 默认实现：把 Tournament + locked players + Room→IN_GAME 单事务落库。 */
export function createPersistenceTournamentStarter(roomRepository: RoomRepository): TournamentStarter {
  return {
    async start(request) {
      await roomRepository.startTournament({
        roomId: request.roomId,
        tournamentId: request.tournamentId,
        tournamentNo: request.tournamentNo,
        configJson: request.config,
        players: request.players,
      });
    },
  };
}
