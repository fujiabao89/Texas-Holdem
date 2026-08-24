import { describe, expect, it } from "vitest";
import { parseArgs, USAGE } from "./cli-args";

const DEFAULT_OUT = "tests/simulator/.artifacts";

describe("parseArgs", () => {
  it("裸 `--` 分隔符被忽略（pnpm/Linux 透传行为，CI 回归：未知参数 --）", () => {
    const args = parseArgs(
      ["--", "--tier", "smoke", "--sha", "fc4ad2ff", "--games", "300"],
      DEFAULT_OUT,
    );
    expect(args.tier).toBe("smoke");
    expect(args.sha).toBe("fc4ad2ff");
    expect(args.games).toBe(300);
    expect(args.out).toBe(DEFAULT_OUT);
  });

  it("`--` 出现在任意位置都被忽略", () => {
    const args = parseArgs(["--seed", "42", "--", "--games", "5"], DEFAULT_OUT);
    expect(args.games).toBe(5);
    expect(args.out).toBe(DEFAULT_OUT);
  });

  it("支持 `=` 内联形式与 --out/--ledger 覆盖", () => {
    const args = parseArgs(
      ["--games=7", "--tier=nightly", "--sha=0f1e2d3", "--ledger=l.json", "--out=tmp"],
      DEFAULT_OUT,
    );
    expect(args).toEqual({
      games: 7,
      tier: "nightly",
      sha: "0f1e2d3",
      ledger: "l.json",
      out: "tmp",
    });
  });

  it("--seed 只跳过不解析（值由 resolveTestSeed 负责）", () => {
    const args = parseArgs(["--seed", "20260821", "--seed=1"], DEFAULT_OUT);
    expect(args.out).toBe(DEFAULT_OUT);
    expect(args.games).toBeUndefined();
  });

  it("未知参数抛错并附带用法", () => {
    expect(() => parseArgs(["--wat"], DEFAULT_OUT)).toThrow(/未知参数 --wat/);
    expect(() => parseArgs(["--wat"], DEFAULT_OUT)).toThrow(USAGE);
  });

  it("非法取值显式抛错", () => {
    expect(() => parseArgs(["--games", "0"], DEFAULT_OUT)).toThrow(/--games/);
    expect(() => parseArgs(["--games", "abc"], DEFAULT_OUT)).toThrow(/--games/);
    expect(() => parseArgs(["--tier", "rcish"], DEFAULT_OUT)).toThrow(/--tier/);
    expect(() => parseArgs(["--sha", "xyz"], DEFAULT_OUT)).toThrow(/--sha/);
    expect(() => parseArgs(["--ledger"], DEFAULT_OUT)).toThrow(/--ledger/);
    expect(() => parseArgs(["--out"], DEFAULT_OUT)).toThrow(/--out/);
  });

  it("空参数返回默认产物目录", () => {
    expect(parseArgs([], DEFAULT_OUT)).toEqual({ out: DEFAULT_OUT });
  });
});
