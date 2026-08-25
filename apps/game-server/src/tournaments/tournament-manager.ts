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
  createRecoveredTournamentRuntimeState,
  createTournamentRuntimeState,
  type PlayerSeed,
  type TournamentRuntimeDeps,
  type TournamentRuntimeView,
} from "./tournament-runtime";
import type { RandomSource, TournamentEngine, TournamentEngineOptions } from "@texas-holdem/poker-engine";
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

/** 崩溃恢复注册输入：由 `TournamentEngine.restore` 重建的权威引擎 + 恢复时点 wire 水位。 */
export interface TournamentRecoverInput {
  readonly tournamentId: string;
  readonly roomId: string;
  readonly players: readonly PlayerSeed[];
  readonly engine: TournamentEngine;
  readonly recovered: { lastWireSequence: number; committedThroughHand: number; engineEventBase: number };
}

export interface TournamentManager {
  /** 创建并注册一场 Tournament 的串行执行器；随后投递 START 驱动首手。 */
  create(input: TournamentCreateInput): void;
  /** 从权威手末快照恢复并注册一场 Tournament（崩溃恢复，docs/04 §13）；随后投递 START 驱动下一手。 */
  createRecovered(input: TournamentRecoverInput): void;
  submit(tournamentId: string, command: TournamentCommand): Promise<unknown>;
  getView(tournamentId: string): TournamentRuntimeView | undefined;
  /** 断线/重连（WS 层上报；仅 HUMAN，幂等）。 */
  setConnection(tournamentId: string, playerId: string, connected: boolean): Promise<unknown>;
  /** 背压暂停/恢复全部活跃 Tournament（当前手结束后停在手间边界，docs/04 §12.2）。 */
  pauseAll(paused: boolean): Promise<unknown>;
  /** 活跃 Tournament id 列表（优雅关停轮询当前手是否结束，§13.1）。 */
  activeTournamentIds(): readonly string[];
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

    createRecovered(input) {
      const runtime = createRecoveredTournamentRuntimeState(
        {
          tournamentId: input.tournamentId,
          roomId: input.roomId,
          players: input.players,
          engine: input.engine,
          recovered: input.recovered,
        },
        deps,
      );
      const executor = new TournamentExecutor(runtime, {
        ...deps.executorDeps,
        output: deps.output,
      });
      runtimes.set(input.tournamentId, executor);
      // 驱动下一手为 fire-and-forget；恢复后事件从快照水位继续（sequence 无缝衔接）。
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

    pauseAll(paused) {
      const submissions: Promise<unknown>[] = [];
      for (const executor of runtimes.values()) {
        submissions.push(
          executor.submit({ type: "PAUSE_AFTER_HAND", paused }).catch(() => undefined),
        );
      }
      return Promise.all(submissions);
    },

    activeTournamentIds() {
      return [...runtimes.keys()];
    },
  };
}
