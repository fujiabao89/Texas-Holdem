import { describe, expect, it } from "vitest";

import { parsePerfArgs } from "./cli";

describe("perf cli.parsePerfArgs", () => {
  it("最小合法：--scenario smoke 得到默认 out 与 keepServer=false", () => {
    const args = parsePerfArgs(["--scenario", "smoke"]);
    expect(args.scenario).toBe("smoke");
    expect(args.keepServer).toBe(false);
    expect(args.out).toBe("tests/performance/.artifacts");
  });

  it("缺 --scenario 抛错", () => {
    expect(() => parsePerfArgs(["--rooms", "3"])).toThrow(/--scenario/);
  });

  it("支持 --flag=value 与 --flag value 两种形式", () => {
    const eq = parsePerfArgs(["--scenario=normal", "--rooms=5", "--sha=abc1234"]);
    const sp = parsePerfArgs(["--scenario", "normal", "--rooms", "5", "--sha", "abc1234"]);
    expect(eq).toEqual(sp);
    expect(eq.rooms).toBe(5);
    expect(eq.sha).toBe("abc1234");
  });

  it("忽略裸 -- 分隔符（pnpm/Linux 透传兼容）", () => {
    const args = parsePerfArgs(["--", "--scenario", "burst", "--", "--players", "6"]);
    expect(args.scenario).toBe("burst");
    expect(args.players).toBe(6);
  });

  it("校验 sha 形状", () => {
    expect(() => parsePerfArgs(["--scenario", "normal", "--sha", "xyz!"])).toThrow(/SHA/);
    expect(parsePerfArgs(["--scenario", "normal", "--sha", "0123456789abcdef"]).sha).toBe(
      "0123456789abcdef",
    );
  });

  it("校验数值参数为正整数", () => {
    expect(() => parsePerfArgs(["--scenario", "normal", "--rooms", "0"])).toThrow(/--rooms/);
    expect(() => parsePerfArgs(["--scenario", "normal", "--duration-ms", "-5"])).toThrow(
      /--duration-ms/,
    );
    expect(() => parsePerfArgs(["--scenario", "normal", "--players", "abc"])).toThrow(/--players/);
  });

  it("--base-url 需要 http(s) URL", () => {
    expect(() => parsePerfArgs(["--scenario", "normal", "--base-url", "localhost:3001"])).toThrow(
      /--base-url/,
    );
    expect(
      parsePerfArgs(["--scenario", "normal", "--base-url", "http://127.0.0.1:3101"]).baseUrl,
    ).toBe("http://127.0.0.1:3101");
  });

  it("未知参数抛错", () => {
    expect(() => parsePerfArgs(["--scenario", "smoke", "--nope"])).toThrow(/未知参数/);
  });

  it("--scenario 重复指定抛错", () => {
    expect(() => parsePerfArgs(["--scenario", "smoke", "--scenario", "burst"])).toThrow(/只能指定一次/);
  });
});
