/**
 * TEX-28 真实链路 E2E 的 Node 侧 HTTP 客户端。
 *
 * 与浏览器 UI 走同一套真实 HTTP 端点（docs/02 §2），用于：
 * - 安全用例中的第三方观察者（第三名玩家经 HTTP 加入 + WS 认证）；
 * - 错误信封断言（未认证 / 非法 Token / 越权 / 非法 body）。
 */
import { randomUUID } from "node:crypto";

import { readRunIdentity } from "./run-identity";

export function serverBaseUrl(): string {
  const identity = readRunIdentity();
  return `http://127.0.0.1:${identity.serverPort}`;
}

export function wsUrl(): string {
  const identity = readRunIdentity();
  return `ws://127.0.0.1:${identity.serverPort}/api/v1/ws`;
}

export interface ApiErrorEnvelope {
  readonly statusCode?: number;
  readonly error?: { readonly code?: unknown; readonly message?: unknown; readonly retryable?: unknown; readonly traceId?: unknown };
  readonly [key: string]: unknown;
}

export async function postJson(
  path: string,
  body: unknown,
  options: { readonly token?: string; readonly idempotencyKey?: string } = {},
): Promise<{ readonly status: number; readonly body: ApiErrorEnvelope }> {
  const response = await fetch(`${serverBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": options.idempotencyKey ?? randomUUID(),
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as ApiErrorEnvelope };
}

export async function patchJson(
  path: string,
  body: unknown,
  options: { readonly token?: string; readonly idempotencyKey?: string } = {},
): Promise<{ readonly status: number; readonly body: ApiErrorEnvelope }> {
  const response = await fetch(`${serverBaseUrl()}${path}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "idempotency-key": options.idempotencyKey ?? randomUUID(),
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as ApiErrorEnvelope };
}

export interface JoinSession {
  readonly roomId: string;
  readonly playerId: string;
  readonly playerToken: string;
  readonly roomRevision: string;
}

export async function joinRoomHttp(inviteCode: string, displayName: string): Promise<JoinSession> {
  const { status, body } = await postJson("/api/v1/rooms/join", { inviteCode, displayName });
  if (status !== 200) throw new Error(`join failed: HTTP ${status} ${JSON.stringify(body)}`);
  const data = (body as { data: { roomId: string; playerId: string; playerToken: string; roomSnapshot: { roomRevision: string } } }).data;
  return { roomId: data.roomId, playerId: data.playerId, playerToken: data.playerToken, roomRevision: data.roomSnapshot.roomRevision };
}

export async function changeSeatHttp(session: JoinSession, seat: number | null): Promise<string> {
  const { status, body } = await patchJson(`/api/v1/rooms/${session.roomId}`, {
    expectedRoomRevision: session.roomRevision,
    operation: { type: "CHANGE_SEAT", seat },
  }, { token: session.playerToken });
  if (status !== 200) throw new Error(`change seat failed: HTTP ${status} ${JSON.stringify(body)}`);
  const revision = (body as { data: { roomSnapshot: { roomRevision: string } } }).data.roomSnapshot.roomRevision;
  return revision;
}