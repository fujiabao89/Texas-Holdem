/**
 * Room/Lobby 领域错误（docs/02-protocol-spec.md §11）。
 *
 * 领域层只抛 `RoomDomainError`（携带稳定 ErrorCode 与白名单 details）；
 * HTTP 层负责将其转换为 `ErrorEnvelope` 并映射 HTTP 状态码。
 * message 仅用于诊断/展示，调用方必须依据 `code` 分支，不得依赖 message。
 */

import type { ErrorCode } from "@texas-holdem/protocol";

export class RoomDomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, string | number | boolean | null>;

  constructor(
    code: ErrorCode,
    options: { message?: string; details?: Record<string, string | number | boolean | null> } = {},
  ) {
    super(options.message ?? code);
    this.name = "RoomDomainError";
    this.code = code;
    this.details = options.details;
  }
}
