import { TournamentResultParamsSchema, TournamentResultQuerySchema } from "@texas-holdem/protocol";
import type { FastifyInstance } from "fastify";
import type { TournamentResultReadRepository } from "../../infrastructure/persistence/repositories/tournament-result";
import { computePlayerTokenDigest, playerTokenDigestsEqual } from "../../infrastructure/persistence/player-token";
import { projectTournamentResult } from "../../projection/tournament-result";
import { RoomDomainError } from "../../rooms/room-errors";
import { toErrorResponse } from "../errors";
import { extractBearerToken } from "../middleware/auth";

export const TOURNAMENT_RESULT_PATH = "/api/v1/tournaments/:tournamentId/result";

export interface TournamentResultRoutesDeps {
  readonly repository: TournamentResultReadRepository;
  readonly tokenSecretForKeyId: (keyId: string) => string | undefined;
  readonly rateLimit: { readonly max: number; readonly timeWindow: string };
  readonly now: () => number;
  readonly makeTraceId: () => string;
}

export function registerTournamentResultRoutes(app: FastifyInstance, deps: TournamentResultRoutesDeps): void {
  app.get(TOURNAMENT_RESULT_PATH, {
    config: { rateLimit: deps.rateLimit },
    // buildApp also sets this before rate-limit hooks, covering their early rejection.
    onRequest(_request, reply, done) { reply.header("Cache-Control", "no-store"); done(); },
  }, async (request, reply) => {
    const traceId = deps.makeTraceId();
    try {
      const params = TournamentResultParamsSchema.safeParse(request.params);
      if (!params.success || !TournamentResultQuerySchema.safeParse(request.query).success) throw new RoomDomainError("INVALID_MESSAGE");
      const token = extractBearerToken(request.headers.authorization);
      if (token === undefined) throw new RoomDomainError("AUTH_REQUIRED");
      if (token.length > 1024) throw new RoomDomainError("AUTH_FAILED");
      const result = await deps.repository.read(params.data.tournamentId, deps.now(), (roomId, members) =>
        members.some((member) => {
          if (member.kind !== "HUMAN" || member.tokenDigest === null || member.tokenKeyId === null) return false;
          const secret = deps.tokenSecretForKeyId(member.tokenKeyId);
          return secret !== undefined && playerTokenDigestsEqual(computePlayerTokenDigest({
            roomId, playerId: member.playerId, token, keyId: member.tokenKeyId, secret,
          }), member.tokenDigest);
        }),
      );
      switch (result.kind) {
        case "not-found": throw new RoomDomainError("TOURNAMENT_NOT_FOUND");
        case "unauthorized": throw new RoomDomainError("AUTH_FAILED");
        case "not-finished": throw new RoomDomainError("TOURNAMENT_NOT_FINISHED");
        case "result": return reply.status(200).send(projectTournamentResult(result.record));
      }
    } catch (error) {
      const { statusCode, envelope } = toErrorResponse(error, traceId);
      return reply.status(statusCode).send(envelope);
    }
  });
}
