/**
 * Tournament 领域错误（docs/02-protocol-spec.md §11；docs/04-game-server-architecture.md §15）。
 *
 * 领域层只抛 `TournamentDomainError`（携带稳定 ErrorCode 与白名单 details）；
 * 调用方必须依据 `code` 分支，不得依赖 message。错误码与 HTTP/WS 的
 * `ErrorEnvelope` 语义一致。
 */

import type { ErrorCode } from "@texas-holdem/protocol";

export class TournamentDomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, string | number | boolean | null>;

  constructor(
    code: ErrorCode,
    options: { message?: string; details?: Record<string, string | number | boolean | null> } = {},
  ) {
    super(options.message ?? code);
    this.name = "TournamentDomainError";
    this.code = code;
    this.details = options.details;
  }
}
