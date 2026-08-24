import {
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  ErrorEnvelopeSchema,
  IdempotencyKeySchema,
  JoinRoomRequestSchema,
  JoinRoomResponseSchema,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type ErrorCode,
  type JoinRoomRequest,
  type JoinRoomResponse,
} from "@texas-holdem/protocol";
import type { z } from "zod";

import { PlayerTokenStore } from "./token-store";

const MAX_JSON_BYTES = 64 * 1024;

export interface HttpTransportOptions {
  readonly apiBaseUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly tokenStore: PlayerTokenStore;
  readonly createUuid: () => string;
  readonly onDiagnostic?: (diagnostic: SafeHttpDiagnostic) => void;
}

export interface SafeHttpDiagnostic {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly status?: number;
  readonly code?: ErrorCode;
}

export type HttpResult<T> = { readonly ok: true; readonly data: T; readonly idempotencyKey: string | undefined }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly retryable: boolean; readonly traceId: string }; readonly idempotencyKey: string | undefined };

export class HttpTransport {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async createRoom(request: CreateRoomRequest, idempotencyKey = this.options.createUuid()): Promise<HttpResult<CreateRoomResponse>> {
    const result = await this.request("POST", "/api/v1/rooms", request, CreateRoomRequestSchema, CreateRoomResponseSchema, { idempotencyKey });
    if (result.ok) this.options.tokenStore.save(result.data.data.roomId, result.data.data.playerToken);
    return result;
  }

  async joinRoom(request: JoinRoomRequest, idempotencyKey = this.options.createUuid()): Promise<HttpResult<JoinRoomResponse>> {
    const result = await this.request("POST", "/api/v1/rooms/join", request, JoinRoomRequestSchema, JoinRoomResponseSchema, { idempotencyKey });
    if (result.ok) this.options.tokenStore.save(result.data.data.roomId, result.data.data.playerToken);
    return result;
  }

  async request<TRequest, TResponse>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    value: TRequest | undefined,
    requestSchema: z.ZodType<TRequest> | undefined,
    responseSchema: z.ZodType<TResponse>,
    options: { readonly roomId?: string; readonly idempotencyKey?: string } = {},
  ): Promise<HttpResult<TResponse>> {
    const idempotencyKey = method === "GET" ? undefined : IdempotencyKeySchema.parse(options.idempotencyKey ?? this.options.createUuid());
    const body = value === undefined ? undefined : encodeSafeJson(requestSchema?.parse(value));
    const token = options.roomId === undefined ? null : this.options.tokenStore.get(options.roomId);
    const headers = new Headers({ Accept: "application/json" });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);

    const url = new URL(path, this.options.apiBaseUrl).toString();
    let response: Response;
    try {
      response = await this.fetchFn(url, { method, headers, body });
    } catch {
      this.diagnostic({ method, path });
      return { ok: false, error: { code: "GAME_UNAVAILABLE", retryable: true, traceId: "network" }, idempotencyKey };
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      const parsed = responseSchema.safeParse(payload);
      if (parsed.success) {
        this.diagnostic({ method, path, status: response.status });
        return { ok: true, data: parsed.data, idempotencyKey };
      }
      this.diagnostic({ method, path, status: response.status, code: "INVALID_MESSAGE" });
      return { ok: false, error: { code: "INVALID_MESSAGE", retryable: false, traceId: "invalid-response" }, idempotencyKey };
    }

    const error = ErrorEnvelopeSchema.safeParse(payload);
    if (error.success) {
      this.diagnostic({ method, path, status: response.status, code: error.data.error.code });
      return { ok: false, error: error.data.error, idempotencyKey };
    }
    this.diagnostic({ method, path, status: response.status, code: "INVALID_MESSAGE" });
    return { ok: false, error: { code: "INVALID_MESSAGE", retryable: false, traceId: "invalid-response" }, idempotencyKey };
  }

  private diagnostic(diagnostic: SafeHttpDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }
}

export function encodeSafeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined || new TextEncoder().encode(json).byteLength > MAX_JSON_BYTES) {
    throw new Error("HTTP JSON request exceeds the 64 KiB transport limit");
  }
  return json;
}
