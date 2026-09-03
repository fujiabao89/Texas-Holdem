/**
 * 真实链路 E2E 的数据库事实读取（TEX-28 字段级安全）。
 *
 * 以 Integration 测试同级的 admin 连接读取服务器私有表 `hand_events`，
 * 提取「真实底牌 / 公开牌」事实，供安全用例断言客户端从未收到未公开底牌。
 * 只读查询；schema 为本次运行的隔离 schema（run-identity，表名经安全模式校验）。
 */
import { createRequire } from "node:module";

import { resolve } from "node:path";

import { readRunIdentity, REPO_ROOT } from "./run-identity";

// pg 是 game-server 的依赖（pnpm 严格 node_modules）；Playwright 转换模块的 require 解析基准不定，
// 用 createRequire(__filename) 锚定本文件真实路径。
const require = createRequire(__filename);
const { Pool } = require(
  resolve(REPO_ROOT, "apps/game-server/node_modules/pg"),
) as typeof import("pg");

export interface GroundTruthCard {
  readonly suit: string;
  readonly rank: number;
}

export interface HandGroundTruth {
  readonly handNumber: number;
  /** 每个座位实际发出的底牌（服务器私有）。 */
  readonly holeCardsBySeat: ReadonlyMap<number, readonly GroundTruthCard[]>;
  /** 摊牌时公开亮出的牌（PLAYER_REVEALED，允许到达客户端）。 */
  readonly revealedCardsBySeat: ReadonlyMap<number, readonly GroundTruthCard[]>;
  /** 公共牌（FLOP/TURN/RIVER，允许到达客户端）。 */
  readonly boardCards: readonly GroundTruthCard[];
}

interface HandEventRow {
  readonly hand_number: number;
  readonly type: string;
  readonly payload: unknown;
}

function asCard(value: unknown): GroundTruthCard | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { suit?: unknown; rank?: unknown };
  // hand_events 持久化的是 Engine Card（小写 suit）；归一化为 wire 域的 UPPER_SNAKE，
  // 以便与客户端实际收到的 CardSchema（rank+suit 均为字符串/UPPER_SNAKE）直接比较。
  return typeof candidate.suit === "string" && typeof candidate.rank === "number"
    ? { suit: candidate.suit.toUpperCase(), rank: candidate.rank }
    : null;
}

function cardsOf(map: Map<number, GroundTruthCard[]>, seatIndex: number): GroundTruthCard[] {
  const existing = map.get(seatIndex);
  if (existing !== undefined) return existing;
  const created: GroundTruthCard[] = [];
  map.set(seatIndex, created);
  return created;
}

/** 读取整个 Tournament 的手牌事实（按 hand_number 分组）。 */
export async function fetchTournamentGroundTruth(
  tournamentId: string,
): Promise<readonly HandGroundTruth[]> {
  const identity = readRunIdentity();
  const pool = new Pool({
    connectionString: process.env.TEX_TEST_DATABASE_URL ?? process.env.DATABASE_URL,
    max: 1,
  });
  try {
    const result = await pool.query<HandEventRow>(
      // hand_events 无 hand_number（列在 hands 表，docs/03 §5.6）：按 hand_id 联表取分组键。
      `SELECT h.hand_number AS hand_number, e.type AS type, e.payload AS payload
         FROM "${identity.schemaName}".hand_events e
         JOIN "${identity.schemaName}".hands h ON h.id = e.hand_id
        WHERE e.tournament_id = $1 AND e.type IN
          ('DEAL_HOLE_CARD', 'PLAYER_REVEALED', 'FLOP_DEALT', 'TURN_DEALT', 'RIVER_DEALT')
        ORDER BY h.hand_number, e.sequence`,
      [tournamentId],
    );
    const hands = new Map<
      number,
      {
        handNumber: number;
        hole: Map<number, GroundTruthCard[]>;
        revealed: Map<number, GroundTruthCard[]>;
        board: GroundTruthCard[];
      }
    >();
    for (const row of result.rows) {
      let hand = hands.get(row.hand_number);
      if (hand === undefined) {
        hand = { handNumber: row.hand_number, hole: new Map(), revealed: new Map(), board: [] };
        hands.set(row.hand_number, hand);
      }
      const payload = row.payload as Record<string, unknown>;
      if (row.type === "DEAL_HOLE_CARD") {
        const card = asCard(payload.card);
        if (card !== null && typeof payload.seatIndex === "number")
          cardsOf(hand.hole, payload.seatIndex).push(card);
      } else if (row.type === "PLAYER_REVEALED") {
        if (typeof payload.seatIndex === "number" && Array.isArray(payload.cards)) {
          for (const item of payload.cards) {
            const card = asCard(item);
            if (card !== null) cardsOf(hand.revealed, payload.seatIndex).push(card);
          }
        }
      } else {
        const cards = row.type === "FLOP_DEALT" ? payload.cards : [payload.card];
        if (Array.isArray(cards)) {
          for (const item of cards) {
            const card = asCard(item);
            if (card !== null) hand.board.push(card);
          }
        }
      }
    }
    return [...hands.values()].map((hand) => ({
      handNumber: hand.handNumber,
      holeCardsBySeat: hand.hole,
      revealedCardsBySeat: hand.revealed,
      boardCards: hand.board,
    }));
  } finally {
    await pool.end();
  }
}
/** 统计某房间的 Tournament 数量（验证「再来一局」创建全新比赛）。 */
export async function countTournamentsForRoom(roomId: string): Promise<number> {
  const identity = readRunIdentity();
  const pool = new Pool({
    connectionString: process.env.TEX_TEST_DATABASE_URL ?? process.env.DATABASE_URL,
    max: 1,
  });
  try {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${identity.schemaName}".tournaments WHERE room_id = $1`,
      [roomId],
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await pool.end();
  }
}

/** 读取某房间最新 Tournament 的 ID（room_id 限定，按创建顺序取最后一个）。 */
export async function latestTournamentIdForRoom(roomId: string): Promise<string> {
  const identity = readRunIdentity();
  const pool = new Pool({
    connectionString: process.env.TEX_TEST_DATABASE_URL ?? process.env.DATABASE_URL,
    max: 1,
  });
  try {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM "${identity.schemaName}".tournaments WHERE room_id = $1 ORDER BY started_at DESC, tournament_no DESC LIMIT 1`,
      [roomId],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error(`房间 ${roomId} 没有 Tournament`);
    return id;
  } finally {
    await pool.end();
  }
}
