/**
 * Tournament 串行队列命令（docs/04-game-server-architecture.md §6/§7）。
 *
 * 同一张桌的全部状态变更、Engine 调用、计时回调与未来 AI Action 都必须是本联合类型
 * 的命令并经唯一串行执行器（tournament-executor.ts）提交；其他模块只读状态或投递命令，
 * 不得直接 mutate（§4 原则、红线 3）。
 *
 * `receivedAt` / `ingressOrdinal` 是服务端入口元数据（§7.2），不是 wire 字段；
 * 由 WS 网关在入口解析并记录，执行器据此做截止点仲裁。
 */

import type { SubmitAction } from "@texas-holdem/protocol";

/** 玩家扑克动作（HUMAN_SOCKET / BOT_CONTROLLER）——同一 Engine 校验路径（§7.5）。 */
export interface SubmitActionCommandInput {
  readonly type: "SUBMIT_ACTION";
  readonly requestId: string;
  /** 业务幂等键（02 §7.3）：tournamentId + playerId + actionId 至多执行一次。 */
  readonly actionId: string;
  readonly playerId: string;
  /** 客户端所见最后 wire sequence（十进制字符串，02 §7.1）。 */
  readonly expectedSequence: string;
  readonly action: SubmitAction;
  /** 服务端单调时钟入口时间（不可伪造）。 */
  readonly receivedAt: number;
  /** 进程内严格递增入口序号（同截止点多个 Action 的先后依据）。 */
  readonly ingressOrdinal: number;
  /** Transport-private epoch; checked at execution time after a device takeover. */
  readonly connectionEpoch?: number;
}

/** Time Bank：Tournament 队列中的 Server 控制命令，不进入 Engine Action 联合类型（§8.1）。 */
export interface UseTimeBankCommandInput {
  readonly type: "USE_TIME_BANK";
  readonly requestId: string;
  readonly playerId: string;
  readonly expectedSequence: string;
  readonly receivedAt: number;
  /** Transport-private epoch; checked at execution time after a device takeover. */
  readonly connectionEpoch?: number;
}

/** 行动超时 Timer 回调（SYSTEM_TIMER 源自动动作）。deadline/generation 固化，执行前复核。 */
export interface SystemTimerActionInput {
  readonly type: "SYSTEM_TIMER_ACTION";
  readonly handId: string;
  readonly seatIndex: number;
  readonly deadline: number;
  readonly generation: number;
  readonly firedAt: number;
}

/** 断线宽限 Timer 回调（满 10 分钟 → EXIT_PENDING）。 */
export interface GraceTimerInput {
  readonly type: "GRACE_TIMER";
  readonly playerId: string;
  readonly seatIndex: number;
  readonly startedAt: number;
  readonly generation: number;
  readonly firedAt: number;
}

/** 主动离开 / 断线宽限到期 → 撤回流程（§6.6；Engine 的 WithdrawParticipant 指令）。 */
export interface WithdrawPlayerInput {
  readonly type: "WITHDRAW_PLAYER";
  readonly playerId: string;
  readonly reason: "USER_LEFT" | "DISCONNECT_TIMEOUT";
}

/** 连接状态变化（WS 层上报；用于宽限计时器与无真人判定，不改变扑克状态）。 */
export interface ConnectionChangedInput {
  readonly type: "CONNECTION_CHANGED";
  readonly playerId: string;
  readonly connected: boolean;
}

/** time 模式升盲：只在 Hand 间上报累计秒数，下一手生效（§6.3）。 */
export interface RecordElapsedTimeInput {
  readonly type: "RECORD_ELAPSED_TIME";
  readonly seconds: number;
}

/** 优雅关停：stopAfterCurrentHand（§13.1）。 */
export interface ShutdownInput {
  readonly type: "SHUTDOWN";
}

/** 驱动首手（创建 Tournament 后由 starter 投递）。 */
export interface StartInput {
  readonly type: "START";
}

export type TournamentCommand =
  | StartInput
  | SubmitActionCommandInput
  | UseTimeBankCommandInput
  | SystemTimerActionInput
  | GraceTimerInput
  | WithdrawPlayerInput
  | ConnectionChangedInput
  | RecordElapsedTimeInput
  | ShutdownInput;
