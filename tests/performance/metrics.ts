/**
 * 压测采样集合与收集器（TEX-29）。
 *
 * driver 在真实动作/重连/HTTP 链路上采集样本（Action→Event 延迟、重连恢复延迟、
 * 计数与功能性不变量计数），门禁（gates.ts）在 run.ts 收尾时对 snapshot 做判定。
 * 本模块只收集计数与延迟样本，不含任何敏感值（底牌/Token 永不进入——见 redaction）。
 */
/** 门禁评估所需的只读指标快照（evaluateSlo 输入）。 */
export interface PerfMetrics {
  /** Action→Event 延迟（ms，命令经 Schema/身份校验后到事件写入 WS）。 */
  readonly actionLatencyMs: readonly number[];
  /** 认证至首个完整 Snapshot 延迟（ms）。 */
  readonly reconnectLatencyMs: readonly number[];
  readonly http5xx: number;
  readonly httpRequests: number;
  /** 意外断连（非测试主动关闭）次数与 WS 连接总数。 */
  readonly unexpectedDisconnect: number;
  readonly wsConnections: number;
  readonly recoveryFailures: number;
  readonly recoveryAttempts: number;
  /** 功能性不变量（投影/引擎/driver 侧）违反数。 */
  readonly invariantViolations: number;
  /** 同桌 sequence / 幂等 / 投影断言失败数（burst 门禁）。 */
  readonly sequenceViolations: number;
  /** 被测进程崩溃标志（本地拉起时探活失败置 true）。 */
  readonly processCrash: boolean;
  /** Soak 内存末小时/稳态小时均值比；driver 无法计算（时长不足/未采集）时为 null。 */
  readonly memoryGrowthRatio: number | null;
}

export class MetricsCollector {
  private readonly actionLatencyMs: number[] = [];
  private readonly reconnectLatencyMs: number[] = [];
  private counters = {
    http5xx: 0,
    httpRequests: 0,
    unexpectedDisconnect: 0,
    wsConnections: 0,
    recoveryFailures: 0,
    recoveryAttempts: 0,
    invariantViolations: 0,
    sequenceViolations: 0,
  };
  private crashed = false;
  private growth: number | null = null;

  pushActionLatency(ms: number): void {
    this.actionLatencyMs.push(ms);
  }

  pushReconnectLatency(ms: number): void {
    this.reconnectLatencyMs.push(ms);
  }

  inc<K extends keyof MetricsCollector["counters"]>(counter: K, by = 1): void {
    this.counters[counter] += by;
  }

  setProcessCrash(): void {
    this.crashed = true;
  }

  setMemoryGrowthRatio(ratio: number | null): void {
    this.growth = ratio;
  }

  /** 冻结快照（数组拷贝，后续 push 不影响已判定输入）。 */
  snapshot(): PerfMetrics {
    return {
      actionLatencyMs: [...this.actionLatencyMs],
      reconnectLatencyMs: [...this.reconnectLatencyMs],
      http5xx: this.counters.http5xx,
      httpRequests: this.counters.httpRequests,
      unexpectedDisconnect: this.counters.unexpectedDisconnect,
      wsConnections: this.counters.wsConnections,
      recoveryFailures: this.counters.recoveryFailures,
      recoveryAttempts: this.counters.recoveryAttempts,
      invariantViolations: this.counters.invariantViolations,
      sequenceViolations: this.counters.sequenceViolations,
      processCrash: this.crashed,
      memoryGrowthRatio: this.growth,
    };
  }
}
