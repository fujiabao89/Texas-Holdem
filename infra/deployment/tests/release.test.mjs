/**
 * release.mjs / artifact-lib.mjs 纯函数单元测试（node:test）。
 * 运行：node --test infra/deployment/tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDeployPlan,
  buildRollbackPlan,
  currentTargetSha,
  isPrefix,
  parseCliArgv,
  parseConfig,
  readState,
  resolveRollbackTarget,
  setCurrentTarget,
  wireCli,
  writeState,
} from "../scripts/release.mjs";
import { computeTreeDigest, sanitizeForAudit } from "../scripts/lib/artifact-lib.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "tex-rel-"));
}

test("parseConfig 校验必填与标识符", () => {
  assert.throws(() => parseConfig({}, "deploy"), /RELEASE_ROOT/);
  const cfg = parseConfig({ RELEASE_ROOT: tempDir(), SERVICE_CONTROL: "systemctl", SERVICE_NAME: "game-server" }, "deploy");
  assert.equal(cfg.serviceControl, "systemctl");
  assert.throws(() => parseConfig({ RELEASE_ROOT: tempDir(), SERVICE_CONTROL: "bogus" }, "deploy"), /SERVICE_CONTROL 非法/);
  assert.throws(() => parseConfig({ RELEASE_ROOT: tempDir(), SERVICE_CONTROL: "systemctl" }, "deploy"), /SERVICE_NAME/);
  assert.throws(() => parseConfig({ RELEASE_ROOT: tempDir(), DATABASE_SCHEMA: "Bad Schema!" }, "deploy"), /DATABASE_SCHEMA 非法/);
});

test("deploy 计划顺序与 fail-safe 描述", () => {
  const cfg = parseConfig({ RELEASE_ROOT: tempDir() }, "deploy");
  const steps = buildDeployPlan(cfg).map((s) => s.step);
  assert.equal(steps[0], "verify-artifact");
  assert.equal(steps[steps.length - 1], "activate");
  assert.ok(steps.indexOf("migrate") > steps.indexOf("stop-current"));
  assert.ok(steps.indexOf("start-candidate") > steps.indexOf("migrate"));
  assert.ok(steps.indexOf("stop-current") > steps.indexOf("verify-unpacked"));
});

test("rollback 计划包含 journal 前缀兼容检查", () => {
  const cfg = parseConfig({ RELEASE_ROOT: tempDir() }, "rollback");
  const steps = buildRollbackPlan(cfg, "abc").map((s) => s.step);
  assert.ok(steps.includes("check-journal-prefix"));
  assert.ok(steps.indexOf("check-journal-prefix") > steps.indexOf("verify-release"));
});

test("isPrefix 前缀判定", () => {
  assert.equal(isPrefix(["a"], ["a", "b", "c"]), true);
  assert.equal(isPrefix(["a", "b"], ["a"]), false);
  assert.equal(isPrefix(["a", "c"], ["a", "b"]), false);
});

test("readState/writeState 往返", async () => {
  const dir = tempDir();
  const p = join(dir, "state.json");
  assert.deepEqual(await readState(p), { schemaVersion: 1, current: null, previous: null, updatedAt: null });
  await writeState(p, { schemaVersion: 1, current: "c".repeat(40), previous: null, updatedAt: "2026-09-08T00:00:00.000Z" });
  const st = await readState(p);
  assert.equal(st.current, "c".repeat(40));
  assert.equal(st.previous, null);
});

test("resolveRollbackTarget：优先 --to，否则 previous，无则拒绝", () => {
  const st = { current: "a".repeat(40), previous: "b".repeat(40) };
  assert.equal(resolveRollbackTarget(st, "c".repeat(40)), "c".repeat(40));
  assert.equal(resolveRollbackTarget(st, null), "b".repeat(40));
  assert.throws(() => resolveRollbackTarget({ current: null, previous: null }, null), /无 previous/);
  assert.throws(() => resolveRollbackTarget(st, "not-a-sha"), /非法 SHA/);
});

test("sanitizeForAudit 剔除敏感字段与长随机值", () => {
  const clean = sanitizeForAudit({
    sha: "a".repeat(40),
    ok: "fine",
    DATABASE_URL: "postgres://u:p@h:5432/db",
    token: "supersecret123456789012345678901234567890",
    nested: { TOKEN_HMAC_SECRET: "x".repeat(40) },
  });
  assert.equal(clean.DATABASE_URL, undefined);
  assert.equal(clean.token, undefined);
  assert.equal(clean.nested.TOKEN_HMAC_SECRET, undefined);
  assert.equal(clean.ok, "fine");
});

test("computeTreeDigest 确定性且内容变化即摘要变化", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "hello");
  writeFileSync(join(dir, "sub", "b.txt"), "world");
  const d1 = await computeTreeDigest(dir);
  const d2 = await computeTreeDigest(dir);
  assert.equal(d1.digest, d2.digest);
  assert.equal(d1.files, 2);
  writeFileSync(join(dir, "a.txt"), "hello!");
  const d3 = await computeTreeDigest(dir);
  assert.notEqual(d1.digest, d3.digest);
});

test("parseCliArgv：--to/--apply/--health-timeout-ms 解析与校验", () => {
  const sha = "a".repeat(40);
  const c = parseCliArgv(["--to", sha, "--apply", "--health-timeout-ms", "5000"]);
  assert.equal(c.to, sha);
  assert.equal(c.apply, true);
  assert.equal(c.healthTimeoutMs, 5000);
  assert.equal(parseCliArgv(["--health-timeout-ms=1234"]).healthTimeoutMs, 1234);
  assert.equal(parseCliArgv([]).apply, false);
  assert.throws(() => parseCliArgv(["--to", "not-a-sha"]), /非法 SHA/);
  assert.throws(() => parseCliArgv(["--health-timeout-ms", "abc"]), /正整数毫秒/);
  assert.throws(() => parseCliArgv(["--health-timeout-ms", "0"]), /正整数毫秒/);
});

test("wireCli：--health-timeout-ms 实际落到 waitHealth 使用的 cfg.healthTimeoutMs", () => {
  const cfg = parseConfig({ RELEASE_ROOT: tempDir() }, "deploy");
  assert.equal(cfg.healthTimeoutMs, 60000);
  wireCli(cfg, parseCliArgv(["--health-timeout-ms", "7000", "--apply"]));
  assert.equal(cfg.healthTimeoutMs, 7000);
});

test("rollback CLI 目标解析：--to 优先于 state.previous，且 exec 计划携带目标", () => {
  const state = { current: "b".repeat(40), previous: "c".repeat(40) };
  const to = "d".repeat(40);
  assert.equal(resolveRollbackTarget(state, to), to);
  assert.equal(resolveRollbackTarget(state, null), state.previous);
  const cfg = parseConfig({ RELEASE_ROOT: tempDir() }, "rollback");
  const plan = buildRollbackPlan(cfg, to);
  const steps = plan.map((s) => s.step);
  const iStop = steps.indexOf("stop-current");
  const iSwitch = steps.indexOf("switch-run-target");
  const iStart = steps.indexOf("start-previous");
  assert.ok(iStop >= 0 && iSwitch > iStop && iStart > iSwitch, "回滚须先切运行目标再启动");
});

test("deploy 计划：switch-run-target 在 stop 之后、start 之前", () => {
  const cfg = parseConfig({ RELEASE_ROOT: tempDir() }, "deploy");
  const steps = buildDeployPlan(cfg).map((s) => s.step);
  const iStop = steps.indexOf("stop-current");
  const iSwitch = steps.indexOf("switch-run-target");
  const iStart = steps.indexOf("start-candidate");
  const iHealth = steps.indexOf("health");
  const iActivate = steps.indexOf("activate");
  assert.ok(iSwitch > iStop && iStart > iSwitch, "服务启动前必须切换到候选运行目标");
  assert.ok(iActivate > iHealth, "health 通过后才写 current/previous 状态");
});

test("current 运行目标：setCurrentTarget/currentTargetSha 往返", async () => {
  const dir = tempDir();
  const cfg = parseConfig({ RELEASE_ROOT: dir }, "deploy");
  const sha = "a".repeat(40);
  mkdirSync(join(cfg.releasesDir, sha, "dist"), { recursive: true });
  writeFileSync(join(cfg.releasesDir, sha, "dist/main.js"), "x");
  assert.equal(await currentTargetSha(cfg), null);
  await setCurrentTarget(cfg, sha);
  assert.equal(await currentTargetSha(cfg), sha);
});
