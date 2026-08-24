/**
 * Tournament 串行执行器（docs/04-game-server-architecture.md §7；核心）。
 *
 * 一张 Tournament 桌的所有状态变更、Engine 调用、事件序列生成、投影与计时回调都经本
 * 执行器的唯一串行队列提交（红线 3）。执行器是 Runtime 的唯一 mutate 者：
 * - 队列内部采用「真队列 + 截止点 look-ahead」：对同一截止点 `D`，所有 `receivedAt <= D`
 *   的 Action/Time Bank 排在 Timer 之前处理，即使它们仍排在 Timer 之后（§7.2）；
 * - 状态转移在队列内同步完成（验证到提交之间不 await 外部 I/O，§7.4）；投影/持久化
 *   消费提交后的不可变结果；
 * - 幂等（actionId）、`expectedSequence`、身份、Turn 与 Engine 校验均先于执行（§7.3）；
 * - 计时以服务器单调时钟为权威；Action Timer / Time Bank / 断线宽限均经可注入
 *   `TimerScheduler` 调度，timer 携带 generation，执行前复核、过期作 no-op（§8.2）。
 *
 * 输出经 `TournamentOutputSink` 投递（wire 事件、CLOCK_UPDATED、Commit Bundle、Room
 * 生命周期命令），TEX-21 连接层订阅事件；Persistence Writer（异步/退避/watermark）
 * 属 TEX-22。
 */

import type {
  CommandResultPayload,
  ErrorCode,
  GameEventMessage,
  SubmitAction,
} from "@texas-holdem/protocol";
import {
  consumeTimeBank,
  resetTimeBankOpportunity,
  type LegalActions,
  type PlayerAction,
  type TournamentState,
} from "@texas-holdem/poker-engine";
import type {
  HandCommitBundle,
  TournamentFinishUpdate,
} from "../infrastructure/persistence/repositories/hand-commit";
import type { RoomCommand } from "../rooms/room-executor";
import {
  projectViewPatch,
  projectWireEvent,
  type ProjectionInput,
} from "../projection/state-projector";
import { TournamentDomainError } from "./tournament-errors";
import { buildHandCommitBundle } from "./tournament-persistence";
import type { TournamentCommand } from "./tournament-commands";
import {
  runtimeView,
  type PlayerRuntimeRecord,
  type TournamentRuntimeState,
  type TournamentRuntimeView,
} from "./tournament-runtime";

/** 断线宽限：10 分钟（§8.3）。 */
export const DISCONNECT_GRACE_MS = 10 * 60 * 1000;
/** Time Bank 单次最多延长/扣除（§8.4）。 */
export const TIME_BANK_STEP_MS = 30_000;
/** 终态 Tournament 保留期：180 天（03 §5.10）。 */
const RETENTION_MS = 180 * 24 * 3600 * 1000;

/** CLOCK_UPDATED wire 载荷（02 §8.2）。 */
export interface ClockUpdatedPayload {
  readonly tournamentId: string;
  readonly handId: string | null;
  readonly currentActorPlayerId: string | null;
  readonly actionDeadline: number | null;
  readonly timeBankRemainingMs: number;
}

/** 执行器输出汇：TEX-21 连接层 / TEX-22 Writer / Room 队列订阅。 */
export interface TournamentOutputSink {
  emitEvents(messages: readonly GameEventMessage[]): void;
  emitClockUpdated(payload: ClockUpdatedPayload): void;
  enqueueCommitBundles(bundles: readonly HandCommitBundle[]): void;
  /** Tournament 在释放自身执行权后向 Room 队列投递生命周期命令（§5.7）。 */
  submitRoomCommand(roomId: string, command: RoomCommand): void;
}

export interface TournamentExecutorDeps {
  readonly output: TournamentOutputSink;
  /** Action Payload 摘要（幂等键内容比较，§7.3）。 */
  readonly hashAction: (action: SubmitAction) => string;
}

interface QueueItem {
  readonly command: TournamentCommand;
  readonly resolve: (result: CommandResultPayload | null) => void;
  readonly reject: (error: unknown) => void;
}

export class TournamentExecutor {
  private readonly state: TournamentRuntimeState;
  private readonly deps: TournamentExecutorDeps;
  private queue: QueueItem[] = [];
  private processing = false;

  constructor(state: TournamentRuntimeState, deps: TournamentExecutorDeps) {
    this.state = state;
    this.deps = deps;
  }

  /** 只读运行时视图（投影与测试用）。 */
  getView(): TournamentRuntimeView {
    return runtimeView(this.state);
  }

  /** 测试用：直接读引擎权威状态。 */
  getEngineState(): TournamentState {
    return this.state.engine.getState();
  }

  /**
   * 提交命令到本桌串行队列；返回命令回执（内部/计时命令返回 null）。
   * 命令在队列内同步处理；入队后若队列空闲则同一微任务内 drain。
   */
  submit(command: TournamentCommand): Promise<CommandResultPayload | null> {
    return new Promise((resolve, reject) => {
      this.queue.push({ command, resolve, reject });
      this.kick();
    });
  }

  private kick(): void {
    if (this.processing) return;
    this.processing = true;
    queueMicrotask(() => this.drain());
  }

  /** 同步 drain 当前队列；look-ahead 确保截止前 Action 优先于 Timer。 */
  private drain(): void {
    try {
      while (this.queue.length > 0) {
        const item = this.takeNext();
        try {
          item.resolve(this.process(item.command));
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** 取下一命令；SYSTEM_TIMER_ACTION 前若有 receivedAt <= D 的 Action/Time Bank 则优先处理（§7.2）。 */
  private takeNext(): QueueItem {
    const head = this.queue[0]!;
    if (head.command.type === "SYSTEM_TIMER_ACTION") {
      const deadline = head.command.deadline;
      for (let i = 1; i < this.queue.length; i++) {
        const command = this.queue[i]!.command;
        if (
          (command.type === "SUBMIT_ACTION" || command.type === "USE_TIME_BANK") &&
          command.receivedAt <= deadline
        ) {
          return this.queue.splice(i, 1)[0]!;
        }
      }
    }
    return this.queue.shift()!;
  }

  private process(command: TournamentCommand): CommandResultPayload | null {
    switch (command.type) {
      case "START":
        this.processStart();
        return null;
      case "SUBMIT_ACTION":
        return this.processAction(command);
      case "USE_TIME_BANK":
        return this.processUseTimeBank(command);
      case "SYSTEM_TIMER_ACTION":
        this.processActionTimer(command);
        return null;
      case "GRACE_TIMER":
        this.processGraceTimer(command);
        return null;
      case "WITHDRAW_PLAYER":
        this.processWithdraw(command);
        return null;
      case "CONNECTION_CHANGED":
        this.processConnection(command);
        return null;
      case "RECORD_ELAPSED_TIME":
        this.processElapsedTime(command);
        return null;
      case "SHUTDOWN":
        this.state.stopAfterCurrentHand = true;
        return null;
    }
  }

  // ---- START / 推进 ----

  private processStart(): void {
    this.advance();
  }

  /** 推进到下一个行动点 / 手 / 终局；手间逻辑（Commit、无真人、停手）在此统一执行。 */
  private advance(): void {
    this.clearActionTimer();
    let guard = 0;
    for (;;) {
      if (guard++ > 200) {
        throw new TournamentDomainError("INTERNAL_ERROR", { message: "advance 循环异常" });
      }
      if (this.checkNoHuman()) return;
      const engineState = this.state.engine.getState();
      if (engineState.phase === "finished") {
        if (!engineState.handInProgress && engineState.handNumber > this.state.committedThroughHand) {
          this.commitCurrentHand(engineState, this.buildFinishUpdate("FINISHED"));
        }
        this.finalizeTournament();
        return;
      }
      if (this.state.status !== "RUNNING") return;
      if (engineState.handInProgress) {
        this.setActionTimer();
        return;
      }
      if (engineState.handNumber > this.state.committedThroughHand) {
        this.commitCurrentHand(engineState);
      }
      if (this.state.stopAfterCurrentHand) return;
      this.state.currentHandId = this.state.ids.uuid();
      this.state.currentHandStartedAt = this.state.clock();
      this.state.engine.startNextHand();
      this.emitNewEvents();
      this.scheduleBlindTimer();
    }
  }

  // ---- Action ----

  private processAction(
    command: Extract<TournamentCommand, { type: "SUBMIT_ACTION" }>,
  ): CommandResultPayload | null {
    const payloadHash = this.deps.hashAction(command.action);
    // actionId 作用域 = tournamentId + playerId（02 §7.3）：键含 playerId 维度。
    const idempotencyKey = `${command.playerId}:${command.actionId}`;
    const cached = this.state.idempotency.get(idempotencyKey);
    if (cached !== undefined) {
      if (cached.payloadHash !== payloadHash) {
        return this.rejected("IDEMPOTENCY_KEY_REUSE", command.requestId, command.actionId);
      }
      const previous = cached.result as CommandResultPayload;
      return {
        requestId: command.requestId,
        actionId: command.actionId,
        status: "APPLIED",
        duplicate: true,
        appliedSequence: previous.appliedSequence,
      };
    }

    const expected = BigInt(command.expectedSequence);
    const current = BigInt(this.state.lastWireSequence);
    const deadline = this.state.actionDeadline;
    // 截止点仲裁（§7.2.4）
    if (deadline !== null && command.receivedAt > deadline) {
      return this.rejected(
        expected === current ? "ACTION_TIMEOUT" : "STALE_GAME_STATE",
        command.requestId,
        command.actionId,
      );
    }
    // sequence 校验（§7.3）
    if (expected !== current) {
      return this.rejected("STALE_GAME_STATE", command.requestId, command.actionId);
    }
    // 身份与 Turn（红线 4）
    const seat = this.seatOf(command.playerId);
    if (seat === null) {
      return this.rejected("FORBIDDEN", command.requestId, command.actionId);
    }
    const hand = this.state.engine.getState().hand;
    if (hand === null || hand.currentActor !== seat) {
      return this.rejected("NOT_YOUR_TURN", command.requestId, command.actionId);
    }

    let legal: LegalActions | null;
    try {
      legal = this.state.engine.applyAction(toEngineAction(command.action, seat));
    } catch (error) {
      return this.rejected(mapEngineError(error), command.requestId, command.actionId);
    }
    this.state.currentLegalActions = legal;
    this.afterEngineTransition();
    const result: CommandResultPayload = {
      requestId: command.requestId,
      actionId: command.actionId,
      status: "APPLIED",
      duplicate: false,
      appliedSequence: String(this.state.lastWireSequence),
    };
    this.state.idempotency.set(idempotencyKey, { payloadHash, result });
    return result;
  }

  // ---- Time Bank ----

  private processUseTimeBank(
    command: Extract<TournamentCommand, { type: "USE_TIME_BANK" }>,
  ): CommandResultPayload | null {
    const requestId = command.requestId;
    if (this.state.config.actionTime === "UNLIMITED") {
      return this.rejected("TIME_BANK_DISABLED", requestId);
    }
    if (BigInt(command.expectedSequence) !== BigInt(this.state.lastWireSequence)) {
      return this.rejected("STALE_GAME_STATE", requestId);
    }
    const seat = this.seatOf(command.playerId);
    const hand = this.state.engine.getState().hand;
    if (seat === null || hand === null || hand.currentActor !== seat) {
      return this.rejected("TIME_BANK_NOT_AVAILABLE", requestId);
    }
    const deadline = this.state.actionDeadline;
    if (deadline !== null && command.receivedAt > deadline) {
      return this.rejected("TIME_BANK_NOT_AVAILABLE", requestId);
    }
    const record = this.state.players.get(command.playerId);
    if (record === undefined) return this.rejected("FORBIDDEN", requestId);
    if (record.timeBank.secondsRemaining <= 0) {
      return this.rejected("TIME_BANK_EMPTY", requestId);
    }
    const consumed = consumeTimeBank(record.timeBank);
    if (consumed === null) {
      return this.rejected("TIME_BANK_NOT_AVAILABLE", requestId);
    }
    const extensionMs = (record.timeBank.secondsRemaining - consumed.secondsRemaining) * 1000;
    record.timeBank = consumed;
    // 新截止线 = 旧截止线 + 延长量，不按命令处理时刻重新起算（§8.4）。
    const newDeadline = (this.state.actionDeadline ?? this.state.clock()) + extensionMs;
    this.state.actionDeadline = newDeadline;
    this.rescheduleActionTimer(newDeadline);
    this.deps.output.emitClockUpdated({
      tournamentId: this.state.tournamentId,
      handId: this.state.currentHandId,
      currentActorPlayerId: command.playerId,
      actionDeadline: newDeadline,
      timeBankRemainingMs: consumed.secondsRemaining * 1000,
    });
    return {
      requestId,
      status: "APPLIED",
      duplicate: false,
      appliedSequence: String(this.state.lastWireSequence),
    };
  }

  // ---- Timer 回调 ----

  private processActionTimer(
    command: Extract<TournamentCommand, { type: "SYSTEM_TIMER_ACTION" }>,
  ): void {
    const engineState = this.state.engine.getState();
    if (engineState.phase === "finished") return;
    const hand = engineState.hand;
    // 执行前复核固化的字段与 generation；任一不匹配 → stale no-op（§8.2）。
    if (hand === null || this.state.currentHandId !== command.handId) return;
    if (hand.currentActor !== command.seatIndex) return;
    if (this.state.actionTimerGeneration !== command.generation) return;
    if (this.state.actionDeadline !== command.deadline) return;
    const legal = this.state.engine.getLegalActions();
    const action: PlayerAction = legal.canCheck
      ? { type: "check", seatIndex: command.seatIndex, source: "system_timer" }
      : { type: "fold", seatIndex: command.seatIndex, source: "system_timer" };
    try {
      this.state.currentLegalActions = this.state.engine.applyAction(action);
    } catch {
      // Timer 自动动作不应失败；Engine 不变量兜底，不再推进。
      return;
    }
    this.afterEngineTransition();
  }

  private processGraceTimer(
    command: Extract<TournamentCommand, { type: "GRACE_TIMER" }>,
  ): void {
    const record = this.state.players.get(command.playerId);
    if (record === undefined) return;
    if (record.connected) return; // 已重连 → no-op
    if (record.graceGeneration !== command.generation) return; // stale
    if (this.state.engine.getState().phase === "finished") return;
    record.graceHandle = null;
    this.processWithdraw({
      type: "WITHDRAW_PLAYER",
      playerId: command.playerId,
      reason: "DISCONNECT_TIMEOUT",
    });
  }

  // ---- 撤回 / 连接 / 升盲 ----

  private processWithdraw(
    command: Extract<TournamentCommand, { type: "WITHDRAW_PLAYER" }>,
  ): void {
    const record = this.state.players.get(command.playerId);
    if (record === undefined) return;
    if (this.state.engine.getState().phase === "finished") return;
    try {
      // WithdrawParticipant 是 Tournament 级 Engine 指令，不占 currentActor（§6.6/§7.5）。
      this.state.engine.withdrawParticipant(record.seatIndex);
    } catch {
      return; // 已撤回/非法 → no-op
    }
    this.afterEngineTransition();
  }

  private processConnection(
    command: Extract<TournamentCommand, { type: "CONNECTION_CHANGED" }>,
  ): void {
    const record = this.state.players.get(command.playerId);
    if (record === undefined || record.kind !== "HUMAN") return;
    record.connected = command.connected;
    if (command.connected) {
      // 重连成功 → 取消断线宽限（旧 generation 失效）。
      if (record.graceHandle !== null) {
        this.state.scheduler.clearTimeout(record.graceHandle);
        record.graceHandle = null;
      }
      record.graceGeneration += 1;
    } else if (record.graceHandle === null) {
      // 断线 → 启动 10 分钟宽限；重复断线不叠加。
      record.graceGeneration += 1;
      const generation = record.graceGeneration;
      const playerId = command.playerId;
      const seatIndex = record.seatIndex;
      const startedAt = this.state.clock();
      record.graceHandle = this.state.scheduler.setTimeout(() => {
        this.submitInternal({
          type: "GRACE_TIMER",
          playerId,
          seatIndex,
          startedAt,
          generation,
          firedAt: this.state.clock(),
        });
      }, DISCONNECT_GRACE_MS);
    }
  }

  private processElapsedTime(
    command: Extract<TournamentCommand, { type: "RECORD_ELAPSED_TIME" }>,
  ): void {
    if (this.state.config.blindMode !== "time") return;
    this.state.engine.recordElapsedTime(command.seconds);
  }

  // ---- 状态转移后统一编排 ----

  private afterEngineTransition(): void {
    this.emitNewEvents();
    this.advance();
  }

  /** 无真人关房：所有真人均 WITHDRAWN → ABANDONED_NO_HUMAN + Room CLOSED（§6.5）。 */
  private checkNoHuman(): boolean {
    if (this.state.status !== "RUNNING") return this.state.status === "ABANDONED_NO_HUMAN";
    const humans = [...this.state.players.values()].filter((p) => p.kind === "HUMAN");
    if (humans.length === 0) return false;
    const engineState = this.state.engine.getState();
    const allWithdrawn = humans.every((p) => {
      const participant = engineState.participants.find((pp) => pp.seatIndex === p.seatIndex);
      return participant?.status === "WITHDRAWN";
    });
    if (allWithdrawn) {
      this.state.status = "ABANDONED_NO_HUMAN";
      // 若有未提交的已完成手，先带 abandoned finish 原子提交（03 §5.7 关房与赛事结果同事务）。
      const engineState = this.state.engine.getState();
      if (!engineState.handInProgress && engineState.handNumber > this.state.committedThroughHand) {
        this.commitCurrentHand(engineState, this.buildFinishUpdate("ABANDONED_NO_HUMAN"));
      }
      this.cancelAllTimers();
      this.deps.output.submitRoomCommand(this.state.roomId, { type: "CLOSE_ROOM", reason: "ABANDONED_NO_HUMAN" });
      return true;
    }
    return false;
  }

  private finalizeTournament(): void {
    this.state.status = "FINISHED";
    this.cancelAllTimers();
    this.deps.output.submitRoomCommand(this.state.roomId, {
      type: "TOURNAMENT_FINISHED",
      tournamentId: this.state.tournamentId,
    });
  }

  // ---- Timer 调度 ----

  private setActionTimer(): void {
    const engineState = this.state.engine.getState();
    const hand = engineState.hand;
    if (hand === null || hand.currentActor === null) return;
    const seat = hand.currentActor;
    const record = this.playerBySeat(seat);
    // 每次建立行动权（新决策点）都复位该行动者的 Time Bank「本机会已使用」标记（§8.4）：
    // 同一座位跨街/跨手连续行动（如 HU 的 BB 收官 preflop 后 postflop 首发）也属新机会。
    if (record !== undefined) {
      record.timeBank = resetTimeBankOpportunity(record.timeBank);
    }
    this.state.currentActorSeat = seat;
    this.state.currentLegalActions = this.state.engine.getLegalActions();
    const config = this.state.config;
    if (config.actionTime === "UNLIMITED") {
      this.state.actionDeadline = null;
      return;
    }
    const deadline = this.state.clock() + config.actionTime * 1000;
    this.state.actionDeadline = deadline;
    this.scheduleActionTimer(deadline, seat);
  }

  private rescheduleActionTimer(newDeadline: number): void {
    const hand = this.state.engine.getState().hand;
    if (hand === null || hand.currentActor === null) return;
    this.scheduleActionTimer(newDeadline, hand.currentActor);
  }

  private scheduleActionTimer(deadline: number, seatIndex: number): void {
    if (this.state.actionTimerHandle !== null) {
      this.state.scheduler.clearTimeout(this.state.actionTimerHandle);
      this.state.actionTimerHandle = null;
    }
    this.state.actionTimerGeneration += 1;
    const generation = this.state.actionTimerGeneration;
    const handId = this.state.currentHandId!;
    const delay = Math.max(0, deadline - this.state.clock());
    this.state.actionTimerHandle = this.state.scheduler.setTimeout(() => {
      this.submitInternal({
        type: "SYSTEM_TIMER_ACTION",
        handId,
        seatIndex,
        deadline,
        generation,
        firedAt: this.state.clock(),
      });
    }, delay);
  }

  private clearActionTimer(): void {
    if (this.state.actionTimerHandle !== null) {
      this.state.scheduler.clearTimeout(this.state.actionTimerHandle);
      this.state.actionTimerHandle = null;
      this.state.actionTimerGeneration += 1;
    }
  }

  /** time 模式定时升盲：按当前盲注等级时长周期上报累计秒数（只在 Hand 间生效，§6.3/§8.1）。 */
  private scheduleBlindTimer(): void {
    if (this.state.config.blindMode !== "time") return;
    if (this.state.status !== "RUNNING") return;
    if (this.state.blindTimerHandle !== null) return; // 已调度；到期后自动续排
    const level = this.state.config.blindStructure[this.state.engine.getState().blindLevel];
    const seconds = level?.durationSeconds ?? 60;
    this.state.blindTimerGeneration += 1;
    this.state.blindTimerHandle = this.state.scheduler.setTimeout(() => {
      this.state.blindTimerHandle = null;
      this.submitInternal({ type: "RECORD_ELAPSED_TIME", seconds });
      this.scheduleBlindTimer();
    }, seconds * 1000);
  }

  private cancelAllTimers(): void {
    this.clearActionTimer();
    if (this.state.blindTimerHandle !== null) {
      this.state.scheduler.clearTimeout(this.state.blindTimerHandle);
      this.state.blindTimerHandle = null;
      this.state.blindTimerGeneration += 1;
    }
    for (const record of this.state.players.values()) {
      if (record.graceHandle !== null) {
        this.state.scheduler.clearTimeout(record.graceHandle);
        record.graceHandle = null;
        record.graceGeneration += 1;
      }
    }
  }

  // ---- 事件发射 / 投影 ----

  /** 把 Engine 新增事件转为逐接收者 wire 消息并分配全局 sequence。 */
  private emitNewEvents(): void {
    const engineEvents = this.state.engine.getEvents();
    const emittedCount = this.state.lastWireSequence;
    const newEvents = engineEvents.slice(emittedCount);
    if (newEvents.length === 0) return;
    const engineState = this.state.engine.getState();
    const board = engineState.hand?.communityCards ?? [];
    const blindLevelIndex = engineState.blindLevel;
    const messages: GameEventMessage[] = [];
    for (const event of newEvents) {
      const wireSeq = event.sequence + 1;
      if (wireSeq !== this.state.lastWireSequence + 1) {
        throw new TournamentDomainError("INTERNAL_ERROR", { message: "Engine 事件 sequence 不连续" });
      }
      this.state.lastWireSequence = wireSeq;
      for (const viewerPlayerId of this.state.players.keys()) {
        const wireEvent = projectWireEvent(event, {
          seatToPlayer: this.state.seatToPlayer,
          viewerPlayerId,
          blindLevelIndex,
          board,
        });
        const patch = projectViewPatch(this.projectionInputFor(viewerPlayerId));
        messages.push({
          type: "GAME_EVENT",
          protocolVersion: 1,
          serverTime: this.state.clock(),
          payload: {
            tournamentId: this.state.tournamentId,
            sequence: String(wireSeq),
            handId: this.state.currentHandId,
            event: wireEvent,
            patch,
          },
        });
      }
    }
    this.deps.output.emitEvents(messages);
  }

  private projectionInputFor(viewerPlayerId: string): ProjectionInput {
    const timeBankRemainingMs = new Map<string, number>();
    for (const [playerId, record] of this.state.players) {
      timeBankRemainingMs.set(playerId, record.timeBank.secondsRemaining * 1000);
    }
    return {
      tournamentId: this.state.tournamentId,
      handId: this.state.currentHandId,
      sequence: this.state.lastWireSequence,
      engineState: this.state.engine.getState(),
      seatToPlayer: this.state.seatToPlayer,
      actionDeadline: this.state.actionDeadline,
      currentLegalActions: this.state.currentLegalActions,
      timeBankRemainingMs,
      viewerPlayerId,
    };
  }

  // ---- 持久化 ----

  /** 手末提交：把自上次提交以来的全部事件组装为 Commit Bundle 交给 Writer；终局手携带 finish。 */
  private commitCurrentHand(
    engineState: TournamentState,
    tournamentFinish?: TournamentFinishUpdate,
  ): void {
    const allEvents = this.state.engine.getEvents();
    if (this.state.committedEventCount >= allEvents.length) return;
    const events = allEvents.slice(this.state.committedEventCount);
    const bundle = buildHandCommitBundle(
      {
        state: this.state,
        engineState,
        handStartedAt: this.state.currentHandStartedAt,
        handEndedAt: this.state.clock(),
        events,
      },
      tournamentFinish,
    );
    this.deps.output.enqueueCommitBundles([bundle]);
    this.state.committedEventCount = allEvents.length;
    this.state.committedThroughHand = engineState.handNumber;
  }

  /** 终局更新（FINISHED/ABANDONED_NO_HUMAN）：Tournament/Room 结果随该手原子落库（03 §5.7/§7.3）。 */
  private buildFinishUpdate(status: "FINISHED" | "ABANDONED_NO_HUMAN"): TournamentFinishUpdate {
    const engineState = this.state.engine.getState();
    const now = new Date(this.state.clock());
    const retention = new Date(this.state.clock() + RETENTION_MS);
    const championSeat = engineState.champion;
    const championPlayerId =
      championSeat !== null ? (this.state.seatToPlayer.get(championSeat) ?? null) : null;
    if (status === "FINISHED") {
      return {
        status,
        championTournamentPlayerId: championPlayerId,
        finishedAt: now,
        retentionExpiresAt: retention,
        roomStatus: "FINISHED",
      };
    }
    return {
      status,
      championTournamentPlayerId: null,
      finishedAt: now,
      retentionExpiresAt: retention,
      roomStatus: "CLOSED",
      roomClosure: {
        closedAt: now,
        closedReason: "ABANDONED_NO_HUMAN",
        retentionExpiresAt: retention,
      },
    };
  }

  // ---- 内部工具 ----

  private seatOf(playerId: string): number | null {
    const record = this.state.players.get(playerId);
    return record?.seatIndex ?? null;
  }

  private playerBySeat(seatIndex: number): PlayerRuntimeRecord | undefined {
    const playerId = this.state.seatToPlayer.get(seatIndex);
    return playerId === undefined ? undefined : this.state.players.get(playerId);
  }

  private submitInternal(command: TournamentCommand): void {
    void this.submit(command).catch(() => {
      // 内部计时任务失败按 stale/no-op 处理（§15）；业务错误已由回执承载。
    });
  }

  private rejected(code: ErrorCode, requestId: string, actionId?: string): CommandResultPayload {
    return {
      requestId,
      actionId,
      status: "REJECTED",
      duplicate: false,
      error: { code, message: code, retryable: false, traceId: this.state.ids.uuid() },
    };
  }
}

/** wire SubmitAction → Engine PlayerAction（金额为本街目标总投入；source 恒 HUMAN_SOCKET）。 */
function toEngineAction(action: SubmitAction, seatIndex: number): PlayerAction {
  switch (action.type) {
    case "FOLD":
      return { type: "fold", seatIndex, source: "human_socket" };
    case "CHECK":
      return { type: "check", seatIndex, source: "human_socket" };
    case "CALL":
      return { type: "call", seatIndex, source: "human_socket" };
    case "BET":
      return { type: "bet", seatIndex, amount: action.betTo, source: "human_socket" };
    case "RAISE":
      return { type: "raise", seatIndex, amount: action.raiseTo, source: "human_socket" };
    case "ALL_IN":
      return { type: "all-in", seatIndex, source: "human_socket" };
  }
}

/** Engine 拒绝原因 → 稳定 ErrorCode（02 §11）。Engine 是唯一合法动作来源。 */
function mapEngineError(error: unknown): ErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("低于最小") || message.includes("超过最大")) return "INVALID_AMOUNT";
  if (message.includes("非当前行动者")) return "NOT_YOUR_TURN";
  return "INVALID_ACTION";
}
