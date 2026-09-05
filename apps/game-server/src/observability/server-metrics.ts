/**
 * Game Server 指标目录（TEX-29，docs/06 §10.2）。
 *
 * 指标名统一在此定义并注册；组件只经名字记录，未注册/标签不符会抛 MetricsError，
 * 防止埋点与抓取定义漂移。标签均为有限集合（method/type/category/status/code），
 * 禁止 room/player/tournament/connection/request 等无限标识。
 */
import { Metrics, type MetricDef, type Labels } from "./metrics";

export const N = {
  httpRequests: "texas_http_requests_total",
  http5xx: "texas_http_5xx_total",
  httpDurationSeconds: "texas_http_request_duration_seconds",
  wsOpened: "texas_ws_connections_opened_total",
  wsClosed: "texas_ws_connections_closed_total",
  wsActive: "texas_ws_active",
  wsMessagesWritten: "texas_ws_messages_written_total",
  wsMessageBytes: "texas_ws_message_bytes_total",
  reconnectAttempts: "texas_reconnect_attempts_total",
  reconnectSuccess: "texas_reconnect_success_total",
  reconnectFailure: "texas_reconnect_failure_total",
  reconnectRecoverySeconds: "texas_reconnect_recovery_seconds",
  actions: "texas_actions_total",
  actionToEventSeconds: "texas_action_to_event_seconds",
  engineCriticalErrors: "texas_engine_critical_errors_total",
  persistenceIntegrityErrors: "texas_persistence_integrity_errors_total",
  persistenceQueueItems: "texas_persistence_queue_items",
  persistenceQueueBytes: "texas_persistence_queue_bytes",
  persistenceQueueOldestSeconds: "texas_persistence_queue_oldest_seconds",
  persistenceWatermarkLevel: "texas_persistence_watermark_level",
  persistenceDegraded: "texas_persistence_degraded",
  persistenceQuarantined: "texas_persistence_quarantined",
  persistenceLastDbLatencySeconds: "texas_persistence_last_db_latency_seconds",
  persistenceConsecutiveFailures: "texas_persistence_consecutive_failures",
  activeRooms: "texas_active_rooms",
  activeTournaments: "texas_active_tournaments",
  processRssBytes: "texas_process_resident_memory_bytes",
  processHeapUsedBytes: "texas_process_heap_used_bytes",
  processHeapTotalBytes: "texas_process_heap_total_bytes",
  processCpuRatio: "texas_process_cpu_ratio",
  eventLoopLagSeconds: "texas_event_loop_lag_seconds",
  uptimeSeconds: "texas_uptime_seconds",
} as const;

const DEFS: readonly MetricDef[] = [
  { name: N.httpRequests, help: "HTTP 请求总数（按方法）", kind: "counter", labelNames: ["method"] },
  { name: N.http5xx, help: "HTTP 5xx 业务/服务端错误响应总数（按方法）", kind: "counter", labelNames: ["method"] },
  { name: N.httpDurationSeconds, help: "HTTP 请求处理耗时", kind: "histogram", labelNames: ["method"] },
  { name: N.wsOpened, help: "WebSocket 连接建立总数", kind: "counter", labelNames: [] },
  { name: N.wsClosed, help: "WebSocket 关闭总数（分类：normal/replaced/abnormal/auth_failed/other）", kind: "counter", labelNames: ["category"] },
  { name: N.wsActive, help: "当前活跃（已认证）WebSocket 连接数", kind: "gauge", labelNames: [] },
  { name: N.wsMessagesWritten, help: "写入 WS 的服务端消息总数（按消息类型）", kind: "counter", labelNames: ["type"] },
  { name: N.wsMessageBytes, help: "写入 WS 的消息字节总数（按消息类型）", kind: "counter", labelNames: ["type"] },
  { name: N.reconnectAttempts, help: "WS 认证/重连尝试总数", kind: "counter", labelNames: [] },
  { name: N.reconnectSuccess, help: "WS 认证/重连成功总数（resumed: 房间存活期内是否已认证过）", kind: "counter", labelNames: ["resumed"] },
  { name: N.reconnectFailure, help: "WS 认证/重连失败总数（按错误码，集合有界）", kind: "counter", labelNames: ["code"] },
  { name: N.reconnectRecoverySeconds, help: "认证至首个完整 Snapshot(RECONNECT_RESULT) 恢复耗时", kind: "histogram", labelNames: [] },
  { name: N.actions, help: "提交的 SUBMIT_ACTION 结果（status: APPLIED/REJECTED；code 为拒绝原因码或 OK）", kind: "counter", labelNames: ["status", "code"] },
  { name: N.actionToEventSeconds, help: "Action 进入服务端(Schema+身份校验后)至结果/事件写入 WS 的耗时（按 status）", kind: "histogram", labelNames: ["status"] },
  { name: N.engineCriticalErrors, help: "Engine Critical Error（不变量违反冻结）总数", kind: "counter", labelNames: [] },
  { name: N.persistenceIntegrityErrors, help: "持久化完整性错误（隔离）总数", kind: "counter", labelNames: [] },
  { name: N.persistenceQueueItems, help: "持久化待提交队列积压 bundle 数", kind: "gauge", labelNames: [] },
  { name: N.persistenceQueueBytes, help: "持久化待提交队列积压字节数", kind: "gauge", labelNames: [] },
  { name: N.persistenceQueueOldestSeconds, help: "持久化队列最旧项等待秒数", kind: "gauge", labelNames: [] },
  { name: N.persistenceWatermarkLevel, help: "持久化水位（0=ok/1=soft/2=hard）", kind: "gauge", labelNames: [] },
  { name: N.persistenceDegraded, help: "持久化降级门控（1=拒新建/soft+，0=正常）", kind: "gauge", labelNames: [] },
  { name: N.persistenceQuarantined, help: "持久化隔离（数据损坏）的锦标赛数", kind: "gauge", labelNames: [] },
  { name: N.persistenceLastDbLatencySeconds, help: "最近一次持久化 DB 写入耗时", kind: "gauge", labelNames: [] },
  { name: N.persistenceConsecutiveFailures, help: "持久化连续失败计数（瞬态退避用）", kind: "gauge", labelNames: [] },
  { name: N.activeRooms, help: "当前活跃 Room 数", kind: "gauge", labelNames: [] },
  { name: N.activeTournaments, help: "当前活跃 Tournament 数", kind: "gauge", labelNames: [] },
  { name: N.processRssBytes, help: "进程 RSS（字节）", kind: "gauge", labelNames: [] },
  { name: N.processHeapUsedBytes, help: "进程堆已用（字节）", kind: "gauge", labelNames: [] },
  { name: N.processHeapTotalBytes, help: "进程堆总量（字节）", kind: "gauge", labelNames: [] },
  { name: N.processCpuRatio, help: "进程 CPU 占用率（最近采样窗口，0..1/核）", kind: "gauge", labelNames: [] },
  { name: N.eventLoopLagSeconds, help: "事件循环滞后（上一采样周期实际耗时 - 期望）", kind: "gauge", labelNames: [] },
  { name: N.uptimeSeconds, help: "进程运行秒数", kind: "gauge", labelNames: [] },
];

export function createServerMetrics(): Metrics {
  const metrics = new Metrics();
  for (const def of DEFS) metrics.register(def);
  return metrics;
}

/** 把枚举型标签编码为稳定字符串的助手（避免 undefined/任意值）。 */
export function labelOf(value: string | undefined | null, fallback = "unknown"): string {
  return value === undefined || value === null || value === "" ? fallback : value;
}

export type { Labels };
