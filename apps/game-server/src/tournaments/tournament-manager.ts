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
  type TournamentRuntimeState,
} from "./tournament-runtime";
import type {
  RandomSource,
  TournamentEngine,
  TournamentEngineOptions,
} from "@texas-holdem/poker-engine";
import type { TournamentConfig } from "@texas-holdem/protocol";
import type { TimerHandle } from "../scheduler/timer-scheduler";

/** 终局 Runtime 只读保留 10 分钟（docs/04 §13.2）；区别于 DB 历史保留期。 */
export const TOURNAMENT_RETENTION_MS = 10 * 60_000;

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
  /** 测试可注入；生产默认使用 §13.2 的 10 分钟。 */
  readonly terminalRetentionMs?: number;
  /** 执行器已 idle 并从 Manager 卸载后通知 Writer 释放其所有权（未提交 Bundle 仍由 Writer 持有）。 */
  readonly onUnloaded?: (tournamentId: string) => void;
}

export interface TournamentRuntimeCounts {
  readonly registered: number;
  readonly running: number;
  readonly finishedRetained: number;
  readonly frozen: number;
}

/** 崩溃恢复注册输入：由 `TournamentEngine.restore` 重建的权威引擎 + 恢复时点 wire 水位。 */
export interface TournamentRecoverInput {
  readonly tournamentId: string;
  readonly roomId: string;
  readonly players: readonly PlayerSeed[];
  readonly engine: TournamentEngine;
  readonly recovered: {
    lastWireSequence: number;
    committedThroughHand: number;
    engineEventBase: number;
    /** 每玩家剩余 Time Bank（来自快照 serverTimeBank；旧快照无 → 满余额回退）。 */
    timeBank?: Record<string, number>;
  };
}

/** 水位 0 重初始化（恢复感知）：首手尚未提交时从配置+参赛者重建，同样按 §13 视为断开并启动宽限。 */
export interface TournamentRecoverFreshInput {
  readonly tournamentId: string;
  readonly roomId: string;
  readonly config: TournamentConfig;
  readonly players: readonly PlayerSeed[];
  readonly rng: RandomSource;
  readonly engineOptions?: TournamentEngineOptions;
}

export interface TournamentManager {
  /** 创建并注册一场 Tournament 的串行执行器；随后投递 START 驱动首手。 */
  create(input: TournamentCreateInput): void;
  /** 从权威手末快照恢复并注册一场 Tournament（崩溃恢复，docs/04 §13）；随后投递 START 驱动下一手。 */
  createRecovered(input: TournamentRecoverInput): void | Promise<void>;
  /** 水位 0 恢复感知重初始化（首手未提交）：标记断开 + 启动宽限，随后投递 START（§13）。 */
  createRecoveredFresh(input: TournamentRecoverFreshInput): void | Promise<void>;
  submit(tournamentId: string, command: TournamentCommand): Promise<unknown>;
  getView(tournamentId: string): TournamentRuntimeView | undefined;
  /** 断线/重连（WS 层上报；仅 HUMAN，幂等）。 */
  setConnection(tournamentId: string, playerId: string, connected: boolean): Promise<unknown>;
  /** 背压暂停/恢复全部活跃 Tournament（当前手结束后停在手间边界，docs/04 §12.2）。 */
  pauseAll(paused: boolean): Promise<unknown>;
  /** 活跃 Tournament id 列表（优雅关停轮询当前手是否结束，§13.1）。 */
  activeTournamentIds(): readonly string[];
  runtimeCounts(): TournamentRuntimeCounts;
  /** CLOSED Room：立即关停该房间全部比赛，等待各自当前内存转移结束后卸载。 */
  disposeRoom(roomId: string): Promise<void>;
  /** 服务关停：拒绝新比赛，取消保留期 timer，并等待全部执行器安全卸载。 */
  dispose(): Promise<void>;
}

export function createTournamentManager(deps: TournamentManagerDeps): TournamentManager {
  const runtimes = new Map<string, TournamentExecutor>();
  const retention = new Map<string, { executor: TournamentExecutor; timer: TimerHandle }>();
  const unloading = new Map<TournamentExecutor, Promise<void>>();
  const retentionMs = deps.terminalRetentionMs ?? TOURNAMENT_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0 || retentionMs > 2_147_483_647) {
    throw new Error("terminalRetentionMs must be a non-negative timer duration");
  }
  let disposed = false;
  let disposal: Promise<void> | null = null;

  function assertUnregistered(tournamentId: string): void {
    if (disposed) throw new TournamentDomainError("GAME_UNAVAILABLE");
    if (runtimes.has(tournamentId)) throw new TournamentDomainError("TOURNAMENT_NOT_ACTIVE");
  }

  function unload(tournamentId: string, executor: TournamentExecutor): Promise<void> {
    const pending = unloading.get(executor);
    if (pending !== undefined) return pending;
    if (runtimes.get(tournamentId) !== executor) return Promise.resolve();
    const retained = retention.get(tournamentId);
    if (retained?.executor === executor) {
      deps.scheduler.clearTimeout(retained.timer);
      retention.delete(tournamentId);
    }
    const completed = executor
      .dispose()
      .then(() => {
        // timer、Room 关闭与 shutdown 可以交错；只有仍持有该实例的 owner 才能删除/通知。
        if (runtimes.get(tournamentId) !== executor) return;
        runtimes.delete(tournamentId);
        deps.onUnloaded?.(tournamentId);
      })
      .finally(() => {
        unloading.delete(executor);
      });
    unloading.set(executor, completed);
    return completed;
  }

  function makeExecutor(runtime: TournamentRuntimeState): TournamentExecutor {
    const executor = new TournamentExecutor(runtime, {
      ...deps.executorDeps,
      output: deps.output,
      onTerminal(context) {
        if (
          !disposed &&
          runtimes.get(runtime.tournamentId) === executor &&
          !unloading.has(executor)
        ) {
          const timer = deps.scheduler.setTimeout(() => {
            if (retention.get(runtime.tournamentId)?.executor !== executor) return;
            void unload(runtime.tournamentId, executor);
          }, retentionMs);
          retention.set(runtime.tournamentId, { executor, timer });
        }
        deps.executorDeps.onTerminal?.(context);
      },
    });
    return executor;
  }

  async function startRecovered(
    runtime: TournamentRuntimeState,
    executor: TournamentExecutor,
  ): Promise<void> {
    runtimes.set(runtime.tournamentId, executor);
    try {
      for (const player of runtime.players.values()) {
        if (player.kind === "HUMAN")
          await executor.submit({
            type: "CONNECTION_CHANGED",
            playerId: player.playerId,
            connected: false,
          });
      }
      await executor.submit({ type: "START" });
      if (executor.getView().status === "FROZEN")
        throw new TournamentDomainError("GAME_UNAVAILABLE");
    } catch (error) {
      // 尚在启动屏障：不留半注册执行器/计时器，失败向上传递给 Room 恢复编排。
      await unload(runtime.tournamentId, executor);
      throw error;
    }
  }

  return {
    create(input) {
      assertUnregistered(input.tournamentId);
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
      const executor = makeExecutor(runtime);
      runtimes.set(input.tournamentId, executor);
      // 驱动首手为 fire-and-forget（Room 队列不等待）；Engine Critical Error 由提交方捕获。
      void executor.submit({ type: "START" }).catch(() => {
        return unload(input.tournamentId, executor);
      });
    },

    async createRecovered(input) {
      assertUnregistered(input.tournamentId);
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
      const executor = makeExecutor(runtime);
      await startRecovered(runtime, executor);
    },

    async createRecoveredFresh(input) {
      assertUnregistered(input.tournamentId);
      const runtime = createTournamentRuntimeState(
        {
          tournamentId: input.tournamentId,
          roomId: input.roomId,
          config: input.config,
          players: input.players,
          rng: input.rng,
          engineOptions: input.engineOptions,
          recoveredDisconnected: true,
        },
        deps,
      );
      const executor = makeExecutor(runtime);
      await startRecovered(runtime, executor);
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
        if (executor.getView().status !== "RUNNING") continue;
        submissions.push(
          executor.submit({ type: "PAUSE_AFTER_HAND", paused }).catch(() => undefined),
        );
      }
      return Promise.all(submissions);
    },

    activeTournamentIds() {
      return [...runtimes]
        .filter(([, executor]) => executor.getView().status === "RUNNING")
        .map(([id]) => id);
    },

    runtimeCounts() {
      const counts = { registered: runtimes.size, running: 0, finishedRetained: 0, frozen: 0 };
      for (const executor of runtimes.values()) {
        const status = executor.getView().status;
        if (status === "RUNNING") counts.running++;
        else if (status === "FROZEN") counts.frozen++;
        else counts.finishedRetained++;
      }
      return counts;
    },

    async disposeRoom(roomId) {
      await Promise.all(
        [...runtimes]
          .filter(([, executor]) => executor.getView().roomId === roomId)
          .map(([id, executor]) => unload(id, executor)),
      );
    },

    dispose() {
      if (disposal !== null) return disposal;
      disposed = true;
      disposal = Promise.all([...runtimes].map(([id, executor]) => unload(id, executor))).then(
        () => undefined,
      );
      return disposal;
    },
  };
}
