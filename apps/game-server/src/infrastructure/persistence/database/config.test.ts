import { describe, expect, it } from "vitest";
import {
  assertValidSchemaName,
  DatabaseConfigError,
  DEFAULT_DATABASE_SCHEMA,
  parseDatabaseConfig,
} from "./config";

describe("parseDatabaseConfig", () => {
  it("requires DATABASE_URL", () => {
    expect(() => parseDatabaseConfig({})).toThrow(DatabaseConfigError);
    expect(() => parseDatabaseConfig({ DATABASE_URL: "  " })).toThrow(DatabaseConfigError);
  });

  it("rejects non-postgres connection strings", () => {
    expect(() => parseDatabaseConfig({ DATABASE_URL: "mysql://u@h/db" })).toThrow(
      DatabaseConfigError,
    );
  });

  it("defaults schema to the private game schema", () => {
    const config = parseDatabaseConfig({ DATABASE_URL: "postgres://u@h/db" });
    expect(config.schema).toBe(DEFAULT_DATABASE_SCHEMA);
    expect(config.pool.max).toBeGreaterThan(0);
  });

  it("accepts an explicit schema and pool overrides", () => {
    const config = parseDatabaseConfig({
      DATABASE_URL: "postgresql://u@h/db",
      DATABASE_SCHEMA: "tex_test_run_20260823_abc123",
      DATABASE_POOL_MAX: "3",
      DATABASE_POOL_IDLE_TIMEOUT_MS: "5000",
      DATABASE_POOL_CONNECTION_TIMEOUT_MS: "2000",
    });
    expect(config.schema).toBe("tex_test_run_20260823_abc123");
    expect(config.pool).toEqual({
      max: 3,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 2000,
    });
  });

  it("rejects invalid pool values and schema names", () => {
    expect(() =>
      parseDatabaseConfig({ DATABASE_URL: "postgres://u@h/db", DATABASE_POOL_MAX: "0" }),
    ).toThrow(DatabaseConfigError);
    expect(() =>
      parseDatabaseConfig({ DATABASE_URL: "postgres://u@h/db", DATABASE_SCHEMA: "Game" }),
    ).toThrow(DatabaseConfigError);
    expect(() =>
      parseDatabaseConfig({ DATABASE_URL: "postgres://u@h/db", DATABASE_SCHEMA: "a; drop" }),
    ).toThrow(DatabaseConfigError);
  });
});

describe("assertValidSchemaName", () => {
  it("accepts simple lowercase identifiers within 63 bytes", () => {
    expect(() => assertValidSchemaName("game")).not.toThrow();
    expect(() => assertValidSchemaName("tex_test_run_20260823_abc123")).not.toThrow();
  });

  it("rejects uppercase, digits-first, specials and over-length names", () => {
    for (const invalid of ["Game", "1abc", "a-b", "a.b", `a${"b".repeat(70)}`]) {
      expect(() => assertValidSchemaName(invalid)).toThrow(DatabaseConfigError);
    }
  });
});
