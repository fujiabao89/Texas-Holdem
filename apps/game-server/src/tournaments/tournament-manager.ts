/**
 * Tournament 集合管理（docs/04-game-server-architecture.md §4/§6）。
 *
 * - 持有全部活跃 Tournament 运行时与其唯一串行执行器；HTTP/WS 只能经 `submit`
 *   投递命令，不得直接 mutate。
 * - 开局由 Room 队列在确认开局条件后经 `TournamentStarter` 创建并注册（§5.7）。
 * - 断线/重连入口 `setConnection` 供 WS 层（TEX-21）调用；不改变扑克状态，只管理
 *   断线宽限计时与无真人判定（§9.3/§6.5）。
 */

import { TournamentDomainError } from "./tournament-errors";
import {
  TournamentExecutor,
  type TournamentExecutorDeps,
  type TournamentOutputSink,
} from "./tournament-executor";
import type { TournamentCommand } from "./tournament-commands";
import {
  createTournamentRuntimeState,
  type PlayerSeed,
  type TournamentRuntimeDeps,
  type TournamentRuntimeView,
} from "./tournament-runtime";
import type { RandomSource, TournamentEngineOptions } from "@texas-holdem/poker-engine";
import type { TournamentConfig } from "@texas-holdem/protocol";

export interface TournamentCreateInput {
  readonly tournamentId: string;
  readonly roomId: string;
  readonly config: TournamentConfig;
  readonly players: readonly PlayerSeed[];
  readonly rng: RandomSource;
  readonly engineOptions?: TournamentEngineOptions;
}

export interface TournamentManagerDeps extends TournamentRuntimeDeps {
  readonly output: TournamentOutputSink;
  readonly executorDeps: Omit<TournamentExecutorDeps, "output">;
}

export interface TournamentManager {
  /** 创建并注册一场 Tournament 的串行执行器；随后投递 START 驱动首手。 */
  create(input: TournamentCreateInput): void;
  submit(tournamentId: string, command: TournamentCommand): Promise<unknown>;
  getView(tournamentId: string): TournamentRuntimeView | undefined;
  /** 断线/重连（WS 层上报；仅 HUMAN，幂等）。 */
  setConnection(tournamentId: string, playerId: string, connected: boolean): Promise<unknown>;
}

export function createTournamentManager(deps: TournamentManagerDeps): TournamentManager {
  const runtimes = new Map<string, TournamentExecutor>();

  return {
    create(input) {
      const runtime = createTournamentRuntimeState(
        {
          tournamentId: input.tournamentId,
          roomId: input.roomId,
          config: input.config,
          players: input.players,
          rng: input.rng,
          engineOptions: input.engineOptions,
        },
        deps,
      );
      const executor = new TournamentExecutor(runtime, {
        ...deps.executorDeps,
        output: deps.output,
      });
      runtimes.set(input.tournamentId, executor);
      // 驱动首手为 fire-and-forget（Room 队列不等待）；Engine Critical Error 由提交方捕获。
      void executor.submit({ type: "START" }).catch(() => {
        runtimes.delete(input.tournamentId);
      });
    },

    submit(tournamentId, command) {
      const executor = runtimes.get(tournamentId);
      if (executor === undefined) {
        return Promise.reject(new TournamentDomainError("TOURNAMENT_NOT_ACTIVE"));
      }
      return executor.submit(command);
    },

    getView(tournamentId) {
      const executor = runtimes.get(tournamentId);
      return executor === undefined ? undefined : executor.getView();
    },

    setConnection(tournamentId, playerId, connected) {
      const executor = runtimes.get(tournamentId);
      if (executor === undefined) {
        return Promise.reject(new TournamentDomainError("TOURNAMENT_NOT_ACTIVE"));
      }
      return executor.submit({ type: "CONNECTION_CHANGED", playerId, connected });
    },
  };
}
