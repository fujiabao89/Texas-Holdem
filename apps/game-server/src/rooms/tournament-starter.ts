/**
 * TournamentStarter port（docs/04-game-server-architecture.md §5.7）。
 *
 * TEX-19 负责"开局原子锁定"：Room 队列确认开局条件后调用本 port 创建
 * Tournament 记录并把 Room 置为 IN_GAME。TEX-20 注入真正的 Tournament 运行时
 * （Hand 循环、Timer、事件序列）：
 * - `createPersistenceTournamentStarter` 仅落库（控制面，Room 提交前执行）；
 * - `createRuntimeTournamentRegistrar` 只在 Room 内存态提交 IN_GAME **之后**
 *   创建并注册 Tournament 串行执行器（TEX-28 F-7），使首手事件晚于 room 快照提交。
 */

import type { TournamentConfig } from "@texas-holdem/protocol";
import type { RandomSource } from "@texas-holdem/poker-engine";
import type { RoomRepository } from "../infrastructure/persistence/repositories";
import type { TournamentManager } from "../tournaments/tournament-manager";

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

export interface TournamentRuntimeRegistrarDeps {
  readonly manager: TournamentManager;
  /** 每场比赛的引擎随机源（生产安全随机；测试可注入 seed 源）。 */
  readonly rngFactory: () => RandomSource;
}

export interface TournamentRuntimeRegistrar {
  /** 在 Room 内存态提交 IN_GAME 之后注册并驱动 Tournament（§5.7；TEX-28 F-7）。 */
  register(request: TournamentStartRequest): void;
}

/**
 * TEX-20：创建并注册 Tournament 串行执行器。只应在 Room 完成内存提交
 * （status=IN_GAME、activeTournamentId 已进入快照）之后调用——确保首手事件
 * （HAND_STARTED/BLIND_POSTED/DEAL_HOLE_CARD）晚于 room 快照提交产出，网关按 room
 * 快照过滤事件时不丢开局首批事件（§5.7/§7.4；TEX-28 F-7）。控制面落库由
 * `createPersistenceTournamentStarter` 负责；两者共享同一份 `TournamentStartRequest`，
 * 保证落库的 `tournament_player.id` 与运行时 seed 一一对应。
 */
export function createRuntimeTournamentRegistrar(deps: TournamentRuntimeRegistrarDeps): TournamentRuntimeRegistrar {
  return {
    register(request) {
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
