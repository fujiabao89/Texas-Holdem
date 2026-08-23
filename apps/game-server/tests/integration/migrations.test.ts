import { afterAll, beforeAll, expect, it } from "vitest";
import { describeTestDatabase } from "../../../../tests/support/test-db";
import {
  generateInviteCode,
  MIGRATIONS_FOLDER,
  qualifiedTableName,
  setupIntegrationDatabase,
  type IntegrationDatabase,
} from "./helpers";

/**
 * 迁移验收（docs/03-data-model.md §15.1）：
 * 空库上版本化迁移可一次成功执行，且核心表/枚举/约束全部落地。
 */

describeTestDatabase("migrations: 空库一次执行成功", (context) => {
  let testDb: IntegrationDatabase | undefined;

  beforeAll(async () => {
    testDb = await setupIntegrationDatabase(context);
  });

  afterAll(async () => {
    await testDb?.end();
  });

  it("创建全部核心表", async () => {
    const result = await testDb!.adminPool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [testDb!.schemaName],
    );
    const tables = result.rows.map((row) => row.table_name);
    for (const expected of [
      "rooms",
      "room_players",
      "tournaments",
      "tournament_players",
      "hands",
      "hand_events",
      "game_snapshots",
      "ai_requests",
    ]) {
      expect(tables, `missing table ${expected}`).toContain(expected);
    }
  });

  it("创建全部枚举类型", async () => {
    const result = await testDb!.adminPool.query<{ typname: string }>(
      `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typtype = 'e' ORDER BY t.typname`,
      [testDb!.schemaName],
    );
    const enums = result.rows.map((row) => row.typname);
    for (const expected of [
      "room_mode",
      "room_status",
      "player_kind",
      "room_player_status",
      "room_player_left_reason",
      "tournament_status",
      "poker_status",
      "hand_end_reason",
      "ai_request_status",
      "ai_fallback_reason",
    ]) {
      expect(enums, `missing enum ${expected}`).toContain(expected);
    }
  });

  it("DEFERRABLE 复合外键已建立（host 与 champion）", async () => {
    const result = await testDb!.adminPool.query<{ conname: string; is_deferrable: boolean }>(
      `SELECT conname, condeferrable FROM pg_constraint
       WHERE connamespace = $1::regnamespace AND contype = 'f' AND condeferrable
       ORDER BY conname`,
      [testDb!.schemaName],
    );
    const deferrable = result.rows.map((row) => row.conname);
    expect(deferrable).toContain("rooms_host_player_fk");
    expect(deferrable).toContain("tournaments_champion_tournament_player_fk");
  });

  it("部分唯一索引（活跃邀请码唯一）已建立", async () => {
    const result = await testDb!.adminPool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'rooms_invite_code_active_unique'`,
      [testDb!.schemaName],
    );
    expect(result.rows[0]?.indexdef).toContain("WHERE");

    const inviteCode = generateInviteCode();
    // 活跃房间占据邀请码。
    await testDb!.adminPool.query(
      `INSERT INTO ${qualifiedTableName(testDb!.schemaName, "rooms")}
       (id, mode, invite_code, status, config_json)
       VALUES ($1, 'MULTIPLAYER', $2, 'LOBBY', '{}')`,
      [crypto.randomUUID(), inviteCode],
    );
    // 第二个同邀请码的活跃房间必须被拒绝（unique violation）。
    await expect(
      testDb!.adminPool.query(
        `INSERT INTO ${qualifiedTableName(testDb!.schemaName, "rooms")}
         (id, mode, invite_code, status, config_json)
         VALUES ($1, 'MULTIPLAYER', $2, 'LOBBY', '{}')`,
        [crypto.randomUUID(), inviteCode],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    // CLOSED 房间不占索引：两个同邀请码的 CLOSED 房间可以共存（邀请码失效后可复用）。
    for (const roomId of [crypto.randomUUID(), crypto.randomUUID()]) {
      await testDb!.adminPool.query(
        `INSERT INTO ${qualifiedTableName(testDb!.schemaName, "rooms")}
         (id, mode, invite_code, status, config_json, closed_reason, created_at, closed_at, retention_expires_at)
         VALUES ($1, 'MULTIPLAYER', $2, 'CLOSED', '{}', 'ABANDONED_NO_HUMAN', now(), now(), now() + interval '180 days')`,
        [roomId, inviteCode],
      );
    }
  });

  it("重复执行迁移是幂等的（journal 已记录则跳过）", async () => {
    // setupIntegrationDatabase 已执行迁移；再跑一次应成功且不报错。
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: testDb!.url, max: 1 });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO ${testDb!.schemaName}`);
    });
    try {
      await migrate(drizzle(pool), {
        migrationsFolder: MIGRATIONS_FOLDER,
        migrationsSchema: testDb!.schemaName,
      });
    } finally {
      await pool.end();
    }
  });
});
