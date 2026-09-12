import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { ErrorEnvelopeSchema } from "@texas-holdem/protocol";
import { registerTournamentResultRoutes } from "./tournament-result";

it("result read failure is a safe retryable HTTP error, never logs private exceptions or affects unrelated routes", async () => {
  const app = Fastify({ logger: false });
  const errors = vi.spyOn(app.log, "error");
  const warnings = vi.spyOn(app.log, "warn");
  const secret = "TOKEN-HOLE-CARDS-DB-PRIVATE-EXCEPTION";
  app.get("/health", () => ({ status: "ok" }));
  registerTournamentResultRoutes(app, {
    repository: { async read() { throw new Error(secret); } },
    tokenSecret: "test-secret", now: Date.now, makeTraceId: randomUUID,
    rateLimit: { max: 100, timeWindow: "1 minute" },
  });
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/tournaments/${randomUUID()}/result`, headers: { authorization: "Bearer test-token" } });
    expect(response.statusCode).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(ErrorEnvelopeSchema.parse(response.json()).error).toMatchObject({ code: "INTERNAL_ERROR", retryable: true });
    expect(response.body).not.toContain(secret);
    expect(errors).not.toHaveBeenCalled(); expect(warnings).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
  } finally { await app.close(); vi.restoreAllMocks(); }
});
