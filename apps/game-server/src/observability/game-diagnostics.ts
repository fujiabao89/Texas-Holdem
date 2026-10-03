import type { Metrics } from "./metrics";
import { N } from "./server-metrics";

/** Closed field list: no command/event payloads or Error objects enter ordinary logs. */
export interface GameDiagnostic {
  event:
    | "HAND_STARTED"
    | "PHASE_CHANGED"
    | "TIMER_IGNORED"
    | "AUTO_ACTION"
    | "ACTION_RESULT"
    | "CONNECTION_CHANGED"
    | "RESYNC_REQUIRED"
    | "SNAPSHOT_REQUESTED"
    | "SNAPSHOT_SENT"
    | "SLOW_CONNECTION_CLOSED";
  roomId: string;
  tournamentId: string | null;
  handId: string | null;
  playerId: string | null;
  eventSequence: string | null;
  timestamp: number;
  trigger: string;
  action?: string;
  errorCode?: string;
  generation?: number;
  currentGeneration?: number;
  deadline?: number | null;
  firedAt?: number;
  receivedAt?: number;
  phase?: string;
  duplicate?: boolean;
  delayMs?: number;
}
export type GameDiagnostics = (record: GameDiagnostic) => void;

export interface BuildIdentity {
  version: string;
  deploymentSha: string | null;
}
export function buildIdentity(
  env: Record<string, string | undefined> = process.env,
): BuildIdentity {
  const version = env.APP_VERSION ?? "0.1.0";
  const sha = env.DEPLOYMENT_SHA;
  return {
    version: /^[A-Za-z0-9._-]{1,64}$/.test(version) ? version : "unknown",
    deploymentSha: sha !== undefined && /^[a-f0-9]{7,40}$/i.test(sha) ? sha.toLowerCase() : null,
  };
}

export function createGameDiagnostics(
  metrics: Metrics,
  identity: BuildIdentity,
  write: (line: string) => void = console.log,
): GameDiagnostics {
  return (record) => {
    // Explicit projection also protects the sink from accidentally widened runtime objects.
    const {
      event,
      roomId,
      tournamentId,
      handId,
      playerId,
      eventSequence,
      timestamp,
      trigger,
      action,
      errorCode,
      generation,
      currentGeneration,
      deadline,
      firedAt,
      receivedAt,
      phase,
      duplicate,
      delayMs,
    } = record;
    try {
      write(
        JSON.stringify({
          app: "game-server",
          ...identity,
          event,
          roomId,
          tournamentId,
          handId,
          playerId,
          eventSequence,
          timestamp,
          trigger,
          action,
          errorCode,
          generation,
          currentGeneration,
          deadline,
          firedAt,
          receivedAt,
          phase,
          duplicate,
          delayMs,
        }),
      );
    } catch {
      /* Diagnostics must never change authority or delivery. */
    }
    if (event === "AUTO_ACTION") metrics.inc(N.autoActions, { action: action! });
    if (event === "TIMER_IGNORED") metrics.inc(N.staleTimers, { trigger });
    if (event === "ACTION_RESULT") {
      if (duplicate) metrics.inc(N.duplicateActions);
      if (trigger === "late") metrics.inc(N.lateActions);
    }
    if (event === "RESYNC_REQUIRED") metrics.inc(N.resyncRequired, { trigger });
    if (event === "SLOW_CONNECTION_CLOSED") metrics.inc(N.slowConnectionsClosed, { trigger });
    if (event === "SNAPSHOT_SENT") {
      metrics.inc(N.snapshotsSent, { trigger });
      if (delayMs !== undefined) metrics.observe(N.resyncRecoverySeconds, delayMs / 1000);
    }
    if (event === "AUTO_ACTION" && delayMs !== undefined)
      metrics.observe(N.actionTimerDelaySeconds, delayMs / 1000);
  };
}
