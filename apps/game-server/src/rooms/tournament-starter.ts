/**
 * TournamentStarter port（docs/04-game-server-architecture.md §5.7）。
 *
 * TEX-19 负责"开局原子锁定"：Room 队列确认开局条件后调用本 port 创建
 * Tournament 记录并把 Room 置为 IN_GAME。TEX-20 注入真正的 Tournament 运行时
 * （Hand 循环、Timer、事件序列）；`createPersistenceTournamentStarter` 仅落库，
 * `createRuntimeTournamentStarter` 在其上创建并注册 Tournament 串行执行器。
 */

import type { TournamentConfig } from "@texas-holdem/protocol";
import type { RandomSource } from "@texas-holdem/poker-engine";
import type { RoomRepository } from "../infrastructure/persistence/repositories";
import type { TournamentManager } from "../tournaments/tournament-manager";
import type { IdSource } from "./id-source";
import type { TimerScheduler } from "../scheduler/timer-scheduler";

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

export interface RuntimeTournamentStarterDeps {
  /** 先持久化控制面（Tournament + locked players + Room→IN_GAME）。 */
  readonly persistence: TournamentStarter;
  readonly manager: TournamentManager;
  readonly clock: () => number;
  readonly ids: IdSource;
  readonly scheduler: TimerScheduler;
  /** 每场比赛的引擎随机源（生产安全随机；测试可注入 seed 源）。 */
  readonly rngFactory: () => RandomSource;
}

/** TEX-20：持久化后在 Room 队列内创建并注册 Tournament 串行执行器（§5.7 开局原子提交）。 */
export function createRuntimeTournamentStarter(deps: RuntimeTournamentStarterDeps): TournamentStarter {
  return {
    async start(request) {
      await deps.persistence.start(request);
      deps.manager.create({
        tournamentId: request.tournamentId,
        roomId: request.roomId,
        config: request.config,
        players: request.players.map((player) => ({
          playerId: player.playerId,
          tournamentPlayerId: player.id,
          displayName: player.displayName,
          seatIndex: player.seatIndex,
          kind: player.kind,
          startingStack: Number(player.startingStack),
        })),
        rng: deps.rngFactory(),
      });
    },
  };
}
