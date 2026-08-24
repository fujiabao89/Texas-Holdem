/**
 * HTTP 错误映射（docs/02-protocol-spec.md §11）。
 *
 * 领域错误 → 稳定 ErrorEnvelope + 推荐 HTTP 状态码；未知/持久化错误一律映射为
 * 可重试的 INTERNAL_ERROR。不泄露堆栈、SQL、Token、内部房间状态或其他玩家私有信息。
 */

import {
  createProtocolError,
  type ErrorCode,
  type ErrorEnvelope,
} from "@texas-holdem/protocol";
import { RoomDomainError } from "../rooms/room-errors";

export interface ErrorResponse {
  readonly statusCode: number;
  readonly envelope: ErrorEnvelope;
}

export function httpStatusForCode(code: ErrorCode): number {
  switch (code) {
    case "AUTH_REQUIRED":
    case "AUTH_FAILED":
      return 401;
    case "FORBIDDEN":
    case "NOT_HOST":
    case "SESSION_REPLACED":
      return 403;
    case "ROOM_NOT_FOUND":
    case "INVALID_INVITE_CODE":
    case "INVITE_EXPIRED":
      return 404;
    case "RATE_LIMITED":
      return 429;
    case "ROOM_FULL":
    case "NICKNAME_TAKEN":
    case "ROOM_LOCKED":
    case "STALE_ROOM_STATE":
    case "STALE_GAME_STATE":
    case "IDEMPOTENCY_KEY_REUSE":
    case "INVALID_ACTION":
      return 409;
    case "GAME_UNAVAILABLE":
      return 503;
    case "INVALID_MESSAGE":
    case "NICKNAME_INVALID":
    case "UNSUPPORTED_PROTOCOL_VERSION":
      return 400;
    default:
      return 500;
  }
}

export function toErrorResponse(error: unknown, traceId: string): ErrorResponse {
  if (error instanceof RoomDomainError) {
    const envelope = {
      error: createProtocolError(error.code, traceId, {
        retryable: error.code === "INTERNAL_ERROR",
        details: error.details,
      }),
    };
    return { statusCode: httpStatusForCode(error.code), envelope };
  }
  const envelope = { error: createProtocolError("INTERNAL_ERROR", traceId, { retryable: true }) };
  return { statusCode: 500, envelope };
}
