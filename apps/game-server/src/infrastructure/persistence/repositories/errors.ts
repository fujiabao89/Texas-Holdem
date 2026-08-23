/**
 * 持久化仓储错误（docs/03-data-model.md §7/§10）。
 *
 * 语义约定：
 * - Integrity 系列错误表示数据损坏或并发提交冲突，调用方必须标记并告警，
 *   不得静默吞掉或以 ON CONFLICT DO NOTHING 掩盖（§7.4）；
 * - 错误消息不包含 token、digest、昵称等敏感值（§6）。
 */

export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceError";
  }
}

/** 目标 Tournament 不存在（事务中止，未写入任何数据）。 */
export class TournamentNotFoundError extends PersistenceError {
  constructor(tournamentId: string) {
    super(`tournament not found: ${tournamentId}`);
    this.name = "TournamentNotFoundError";
  }
}

/** Event 序列与水位线不对齐（缺口/越界/末位不等于 Snapshot.sequence）。 */
export class SequenceIntegrityError extends PersistenceError {
  constructor(message: string) {
    super(message);
    this.name = "SequenceIntegrityError";
  }
}

/** 本手 hand_sequence 不从 1 连续递增。 */
export class HandSequenceIntegrityError extends PersistenceError {
  constructor(message: string) {
    super(message);
    this.name = "HandSequenceIntegrityError";
  }
}

/** 同 ID 已存在但内容不同：疑似数据损坏，必须告警而不是覆盖（§7.4）。 */
export class CommitChecksumMismatchError extends PersistenceError {
  constructor(handId: string) {
    super(`commit checksum mismatch for existing hand ${handId}: possible data corruption`);
    this.name = "CommitChecksumMismatchError";
  }
}

/** 同 ID 部分提交（如 hand 存在但 snapshot 缺失）：原子性被破坏的信号（§7.4）。 */
export class PartialCommitConflictError extends PersistenceError {
  constructor(handId: string) {
    super(`partial commit conflict for hand ${handId}: atomicity violated`);
    this.name = "PartialCommitConflictError";
  }
}
