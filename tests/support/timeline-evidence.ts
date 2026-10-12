const EVENTS = new Set([
  "HAND_STARTED",
  "PHASE_CHANGED",
  "TIMER_IGNORED",
  "AUTO_ACTION",
  "ACTION_RESULT",
  "CONNECTION_CHANGED",
  "RESYNC_REQUIRED",
  "SNAPSHOT_REQUESTED",
  "SNAPSHOT_SENT",
  "SLOW_CONNECTION_CLOSED",
]);
const FIELDS = [
  "event",
  "roomId",
  "tournamentId",
  "handId",
  "playerId",
  "eventSequence",
  "timestamp",
  "trigger",
  "action",
  "errorCode",
  "generation",
  "currentGeneration",
  "deadline",
  "firedAt",
  "receivedAt",
  "phase",
  "duplicate",
  "delayMs",
  "version",
  "deploymentSha",
] as const;

export type SafeDiagnostic = Record<string, string | number | boolean | null>;
/** Returns a boolean only: never include a leaked credential in an assertion failure. */
export function isSafeEvidence(value: unknown, secrets: readonly string[] = []): boolean {
  const serialized = JSON.stringify(value);
  if (
    serialized === undefined ||
    /postgres(?:ql)?:\/\//i.test(serialized) ||
    secrets.some((secret) => secret.length > 0 && serialized.includes(secret))
  )
    return false;
  const visit = (item: unknown): boolean => {
    if (item === null || typeof item !== "object") return true;
    return Object.entries(item).every(
      ([key, child]) =>
        !/^(payload|playerToken|authorization|headers|cookies|deck|holeCards|privateHoleCards|burnCards|rank|suit)$/i.test(
          key,
        ) && visit(child),
    );
  };
  return visit(value);
}
/** Re-project production's diagnostic lines; arbitrary stdout, payloads and error stacks never persist. */
export function safeDiagnostic(line: string): SafeDiagnostic | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    value === null ||
    value.app !== "game-server" ||
    typeof value.event !== "string" ||
    !EVENTS.has(value.event)
  )
    return null;
  const result: SafeDiagnostic = {};
  for (const key of FIELDS) {
    const item = value[key];
    if (
      item === null ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item)) ||
      (typeof item === "string" && item.length <= 128)
    )
      result[key] = item;
  }
  return result;
}

export interface DomSample {
  at: number;
  handId: string | null;
  actionHandId: string | null;
  outcomeHandId: string | null;
  mode: string | null;
  phase: string | null;
  reduced: boolean;
  visibility: string;
  kind: string;
  animation?: string;
  dealKey?: string;
  showdown?: boolean;
  synchronized?: boolean;
  awardLines?: string[];
}

export function completedHandIds(
  frames: readonly {
    type: string;
    handId: string | null;
    sequence: string | null;
    event?: string;
    phase?: string | null;
  }[],
): Set<string> {
  const completed = new Set<string>();
  const awarded = new Map<string, bigint>();
  for (const frame of frames) {
    if (frame.handId === null || frame.sequence === null) continue;
    const sequence = BigInt(frame.sequence);
    if (
      (frame.type === "GAME_SNAPSHOT" || frame.type === "RECONNECT_RESULT") &&
      (frame.phase === "SHOWDOWN_DISPLAY" || frame.phase === "HAND_END")
    )
      completed.add(frame.handId);
    if (frame.type !== "GAME_EVENT") continue;
    if (frame.event === "POT_AWARDED") awarded.set(frame.handId, sequence);
    if (frame.event === "HAND_STARTED" || frame.event === "TOURNAMENT_FINISHED") {
      for (const [handId, lastAward] of awarded) {
        if (
          sequence > lastAward &&
          (frame.event === "TOURNAMENT_FINISHED" || handId !== frame.handId)
        ) {
          completed.add(handId);
          awarded.delete(handId);
        }
      }
    }
  }
  return completed;
}

export function timelineViolations(samples: readonly DomSample[]): string[] {
  let outcome: { hand: string; start: number } | null = null;
  let showdownStart: number | null = null;
  const deals = new Set<string>();
  const outcomes = new Set<string>();
  return samples.flatMap((sample) => {
    const issues: string[] = [];
    if (sample.kind === "animationstart" && sample.dealKey !== undefined) {
      const key = `${sample.dealKey}/${sample.animation}`;
      if (deals.has(key)) issues.push(`replayed deal animation ${key}`);
      deals.add(key);
    }
    if (sample.actionHandId !== null && sample.handId !== sample.actionHandId)
      issues.push(`mixed-hand action at ${sample.at}`);
    if (
      sample.outcomeHandId !== null &&
      sample.actionHandId !== null &&
      sample.outcomeHandId !== sample.actionHandId
    )
      issues.push(`old outcome with new action at ${sample.at}`);
    if (outcome !== null && sample.outcomeHandId !== outcome.hand) {
      if (
        sample.at - outcome.start < 1000 &&
        !sample.synchronized &&
        sample.visibility === "visible"
      )
        issues.push(`outcome disappeared before minimum hold at ${sample.at}`);
      outcome = null;
    }
    if (outcome === null && sample.outcomeHandId !== null) {
      if (outcomes.has(sample.outcomeHandId))
        issues.push(`replayed outcome ${sample.outcomeHandId}`);
      outcomes.add(sample.outcomeHandId);
      outcome = { hand: sample.outcomeHandId, start: sample.at };
    }
    if (sample.showdown && showdownStart === null) showdownStart = sample.at;
    if (!sample.showdown && showdownStart !== null) {
      if (
        sample.at - showdownStart < 1000 &&
        !sample.synchronized &&
        sample.visibility === "visible"
      )
        issues.push(`showdown interrupted without recovery notice at ${sample.at}`);
      showdownStart = null;
    }
    return issues;
  });
}

export function validGateStats(
  stats: { expected?: number; skipped?: number; unexpected?: number; flaky?: number },
  count: number,
): boolean {
  return (
    stats.expected === count && stats.skipped === 0 && stats.unexpected === 0 && stats.flaky === 0
  );
}

interface GateReport {
  stats?: Parameters<typeof validGateStats>[0];
  suites?: GateSuite[];
}
interface GateSuite {
  suites?: GateSuite[];
  specs?: {
    tests: {
      projectName: string;
      expectedStatus: string;
      results: { status: string; retry: number }[];
    }[];
  }[];
}
/** Counts alone cannot detect test.fail()/xfail or replacement of a required browser. */
export function validGateReport(
  report: GateReport,
  matrix: Readonly<Record<string, number>>,
): boolean {
  const count = Object.values(matrix).reduce((sum, value) => sum + value, 0);
  if (!validGateStats(report.stats ?? {}, count)) return false;
  const tests = (suite: GateSuite): NonNullable<GateSuite["specs"]>[number]["tests"] => [
    ...(suite.specs ?? []).flatMap((spec) => spec.tests),
    ...(suite.suites ?? []).flatMap(tests),
  ];
  const selected = tests(report);
  if (
    selected.length !== count ||
    selected.some(
      (test) =>
        test.expectedStatus !== "passed" ||
        test.results.length !== 1 ||
        test.results[0]?.status !== "passed" ||
        test.results[0].retry !== 0,
    )
  )
    return false;
  const actual: Record<string, number> = {};
  for (const test of selected) actual[test.projectName] = (actual[test.projectName] ?? 0) + 1;
  return (
    Object.keys(actual).length === Object.keys(matrix).length &&
    Object.entries(matrix).every(([browser, expected]) => actual[browser] === expected)
  );
}

export function authoritativeViolations(
  logs: readonly SafeDiagnostic[],
  actionMs = 15_000,
): string[] {
  const issues: string[] = [];
  const starts = new Set<string>();
  const opened = new Map<string, number>();
  for (const row of logs) {
    const key = `${row.tournamentId}/${row.handId}`;
    if (row.event === "HAND_STARTED") {
      if (starts.has(key)) issues.push(`duplicate HAND_STARTED ${key}`);
      starts.add(key);
    }
    if (
      row.event === "PHASE_CHANGED" &&
      row.phase === "ACTION_OPEN" &&
      typeof row.deadline === "number" &&
      typeof row.timestamp === "number"
    ) {
      // Diagnostic timestamp is read after Timer creation. A fixed 100ms observation budget
      // tolerates scheduling overhead, never the 4-second presentation deduction.
      const duration = row.deadline - row.timestamp;
      if (duration < actionMs - 100 || duration > actionMs + 100)
        issues.push(`incomplete action window ${key}: ${duration}`);
      opened.set(key, row.deadline);
    }
    if (
      row.event === "AUTO_ACTION" &&
      typeof row.deadline === "number" &&
      typeof row.firedAt === "number"
    ) {
      if (row.firedAt < row.deadline) issues.push(`early AUTO_ACTION ${key}`);
      if (typeof opened.get(key) === "number" && row.deadline < opened.get(key)!)
        issues.push(`old deadline acted on new hand ${key}`);
    }
  }
  return issues;
}
