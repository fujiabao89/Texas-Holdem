import {
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  ErrorEnvelopeSchema,
  IdempotencyKeySchema,
  JoinRoomRequestSchema,
  JoinRoomResponseSchema,
  LeaveRoomRequestSchema,
  LeaveRoomResponseSchema,
  StartTournamentRequestSchema,
  StartTournamentResponseSchema,
  UpdateRoomRequestSchema,
  UpdateRoomResponseSchema,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type ErrorCode,
  type JoinRoomRequest,
  type JoinRoomResponse,
  type LeaveRoomResponse,
  type StartTournamentRequest,
  type StartTournamentResponse,
  type UpdateRoomRequest,
  type UpdateRoomResponse,
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
  readonly clock?: HttpClock;
  readonly defaultTimeoutMs?: number;
}

export interface HttpClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HttpRequestOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface SafeHttpDiagnostic {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly status?: number;
  readonly code?: ErrorCode;
}

export type HttpResult<T> = { readonly ok: true; readonly data: T; readonly idempotencyKey: string | undefined }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly retryable: boolean; readonly traceId: string; readonly reason?: "NETWORK" | "TIMEOUT" | "CANCELLED" }; readonly idempotencyKey: string | undefined };

export class HttpTransport {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async createRoom(request: CreateRoomRequest, requestOptions: HttpRequestOptions = {}): Promise<HttpResult<CreateRoomResponse>> {
    const result = await this.request("POST", "/api/v1/rooms", request, CreateRoomRequestSchema, CreateRoomResponseSchema, requestOptions);
    if (result.ok) this.options.tokenStore.save(result.data.data.roomId, result.data.data.playerToken, result.data.data.playerId);
    return result;
  }

  async joinRoom(request: JoinRoomRequest, requestOptions: HttpRequestOptions = {}): Promise<HttpResult<JoinRoomResponse>> {
    const result = await this.request("POST", "/api/v1/rooms/join", request, JoinRoomRequestSchema, JoinRoomResponseSchema, requestOptions);
    if (result.ok) this.options.tokenStore.save(result.data.data.roomId, result.data.data.playerToken, result.data.data.playerId);
    return result;
  }

  updateRoom(roomId: string, request: UpdateRoomRequest, requestOptions: HttpRequestOptions = {}): Promise<HttpResult<UpdateRoomResponse>> {
    return this.request("PATCH", `/api/v1/rooms/${encodeURIComponent(roomId)}`, request, UpdateRoomRequestSchema, UpdateRoomResponseSchema, { ...requestOptions, roomId });
  }

  startTournament(roomId: string, request: StartTournamentRequest, requestOptions: HttpRequestOptions = {}): Promise<HttpResult<StartTournamentResponse>> {
    return this.request("POST", `/api/v1/rooms/${encodeURIComponent(roomId)}/tournaments`, request, StartTournamentRequestSchema, StartTournamentResponseSchema, { ...requestOptions, roomId });
  }

  leaveRoom(roomId: string, requestOptions: HttpRequestOptions = {}): Promise<HttpResult<LeaveRoomResponse>> {
    return this.request("POST", `/api/v1/rooms/${encodeURIComponent(roomId)}/leave`, {}, LeaveRoomRequestSchema, LeaveRoomResponseSchema, { ...requestOptions, roomId });
  }

  async request<TRequest, TResponse>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    value: TRequest | undefined,
    requestSchema: z.ZodType<TRequest> | undefined,
    responseSchema: z.ZodType<TResponse>,
    options: HttpRequestOptions & { readonly roomId?: string } = {},
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
    let payload: unknown;
    try {
      const controlled = await fetchWithControls(this.fetchFn, url, { method, headers, body }, options, this.options.clock ?? browserClock, this.options.defaultTimeoutMs ?? 10_000);
      response = controlled.response;
      payload = controlled.payload;
    } catch (error) {
      const reason = error instanceof HttpControlError ? error.reason : failureReason(options);
      this.diagnostic({ method, path });
      return { ok: false, error: { code: "GAME_UNAVAILABLE", retryable: true, traceId: "network", reason }, idempotencyKey };
    }

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

const browserClock: HttpClock = { setTimeout: (callback, delayMs) => setTimeout(callback, delayMs), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

async function fetchWithControls(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  options: HttpRequestOptions,
  clock: HttpClock,
  defaultTimeoutMs: number,
): Promise<{ response: Response; payload: unknown }> {
  if (options.signal?.aborted) throw new HttpControlError("CANCELLED");
  const controller = new AbortController();
  let failure: "TIMEOUT" | "CANCELLED" | undefined;
  const timeout = clock.setTimeout(() => { failure = "TIMEOUT"; controller.abort(); }, options.timeoutMs ?? defaultTimeoutMs);
  const onAbort = () => { failure = "CANCELLED"; controller.abort(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    const payload = await response.json().catch(() => {
      if (controller.signal.aborted) throw new HttpControlError(failure ?? "CANCELLED");
      return undefined;
    });
    return { response, payload };
  } catch (error) {
    if (failure !== undefined) throw new HttpControlError(failure);
    throw error;
  } finally {
    clock.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

class HttpControlError extends Error {
  constructor(readonly reason: "TIMEOUT" | "CANCELLED") { super(reason); }
}

function failureReason(options: HttpRequestOptions): "NETWORK" | "TIMEOUT" | "CANCELLED" {
  return options.signal?.aborted ? "CANCELLED" : "NETWORK";
}

export function encodeSafeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined || new TextEncoder().encode(json).byteLength > MAX_JSON_BYTES) {
    throw new Error("HTTP JSON request exceeds the 64 KiB transport limit");
  }
  return json;
}
