-- 最小权限迁移（docs/03-data-model.md §9）。
--
-- 目标：
-- 1. 表所在 schema 对 anon/authenticated/PUBLIC 默认拒绝（私有 schema + 显式 REVOKE 双保险）；
-- 2. 只有 game_server 专用角色获得运行所需的最小权限（schema USAGE + 表 DML + 序列 USAGE）。
--
-- 角色说明：
-- - Supabase 项目中 anon/authenticated 已存在；本地/测试库不存在时创建 NOLOGIN 占位。
-- - game_server 角色在生产由 DBA 预先以 LOGIN 创建（密码只进连接串，不入库）；
--   本地/测试库不存在时同样创建 NOLOGIN 占位，仅用于 SET ROLE 验证。
-- - `current_schema()` 取执行迁移时连接的 search_path 目标 schema，
--   因此同一迁移可用于生产 `game` schema 与测试隔离 schema。
DO $$
DECLARE
  target_schema text := current_schema();
BEGIN
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN;
    END IF;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'game_server') THEN
      CREATE ROLE game_server NOLOGIN;
    END IF;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC, anon, authenticated', target_schema);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC, anon, authenticated', target_schema);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM PUBLIC, anon, authenticated', target_schema);

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO game_server', target_schema);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO game_server', target_schema);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO game_server', target_schema);

  -- 未来由本迁移执行角色新建的对象延续同样的 ACL。
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated', target_schema);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO game_server', target_schema);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated', target_schema);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO game_server', target_schema);
END
$$;
