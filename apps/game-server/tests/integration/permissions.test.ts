import { afterAll, beforeAll, expect, it } from "vitest";
import { describeTestDatabase } from "../../../../tests/support/test-db";
import { generateInviteCode, qualifiedTableName, setupIntegrationDatabase, type IntegrationDatabase } from "./helpers";

/**
 * 最小权限验收（docs/03-data-model.md §9/§15.7，任务测试项 7）：
 * anon/authenticated 对所有原始表读写均被拒绝；game_server 角色具备运行权限。
 */

const ALL_TABLES = [
  "rooms",
  "room_players",
  "tournaments",
  "tournament_players",
  "hands",
  "hand_events",
  "game_snapshots",
  "ai_requests",
] as const;

describeTestDatabase("permissions: anon/authenticated 无法读写原始表", (context) => {
  let testDb: IntegrationDatabase | undefined;

  beforeAll(async () => {
    testDb = await setupIntegrationDatabase(context);
    // 放一行数据，确保 SELECT 语义上"有东西可读"，权限拒绝不是因为空表。
    await testDb!.adminPool.query(
      `INSERT INTO ${qualifiedTableName(testDb!.schemaName, "rooms")}
       (id, mode, invite_code, status, config_json)
       VALUES ($1, 'MULTIPLAYER', $2, 'CREATED', '{}')`,
      [crypto.randomUUID(), generateInviteCode()],
    );
  });

  afterAll(async () => {
    await testDb?.end();
  });

  for (const role of ["anon", "authenticated"] as const) {
    it(`${role} 无法 SELECT 任何原始表`, async () => {
      for (const table of ALL_TABLES) {
        const result = await testDb!.adminPool.query(
          `SELECT has_table_privilege($1, $2, 'SELECT') AS allowed`,
          [role, qualifiedTableName(testDb!.schemaName, table)],
        );
        expect(result.rows[0]?.allowed, `${role} should not SELECT ${table}`).toBe(false);
      }
    });

    it(`${role} 无法 INSERT 任何原始表（SET ROLE 实测）`, async () => {
      const client = await testDb!.adminPool.connect();
      try {
        await client.query(`SET ROLE ${role}`);
        for (const table of ALL_TABLES) {
          await expect(
            client.query(`INSERT INTO ${qualifiedTableName(testDb!.schemaName, table)} DEFAULT VALUES`),
          ).rejects.toThrow(/permission denied/i);
        }
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }
    });
  }

  it("anon 对 schema 无 USAGE（连限定名查询都被拒）", async () => {
    const client = await testDb!.adminPool.connect();
    try {
      await client.query("SET ROLE anon");
      await expect(
        client.query(`SELECT * FROM ${qualifiedTableName(testDb!.schemaName, "rooms")}`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
  });

  it("game_server 角色可读可写运行所需表", async () => {
    const client = await testDb!.adminPool.connect();
    try {
      await client.query("SET ROLE game_server");
      const select = await client.query(`SELECT count(*) FROM ${qualifiedTableName(testDb!.schemaName, "rooms")}`);
      expect(Number(select.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(1);
      // INSERT 权限实测（BOT 合法行，无凭证）。
      const roomId = await client.query<{ id: string }>(
        `SELECT id FROM ${qualifiedTableName(testDb!.schemaName, "rooms")} LIMIT 1`,
      );
      const insert = await client.query(
        `INSERT INTO ${qualifiedTableName(testDb!.schemaName, "room_players")}
         (id, room_id, display_name, display_name_key, kind, token_digest, token_key_id, status)
         VALUES ($1, $2, 'PermBot', 'permbot', 'BOT', NULL, NULL, 'ACTIVE') RETURNING id`,
        [crypto.randomUUID(), roomId.rows[0]?.id],
      );
      expect(insert.rows).toHaveLength(1);
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
  });
});
