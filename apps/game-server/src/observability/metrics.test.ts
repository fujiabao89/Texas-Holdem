import { describe, expect, it } from "vitest";
import { DEFAULT_BUCKETS_SECONDS, Metrics, MetricsError } from "./metrics";

function labelled() {
  const m = new Metrics();
  m.register({ name: "texas_test_total", help: "counter", kind: "counter", labelNames: ["kind"] });
  m.register({ name: "texas_test_gauge", help: "gauge", kind: "gauge", labelNames: [] });
  m.register({ name: "texas_test_hist", help: "hist", kind: "histogram", labelNames: ["status"] });
  return m;
}

describe("Metrics", () => {
  it("counter 递增并渲染 HELP/TYPE 与值", () => {
    const m = labelled();
    m.inc("texas_test_total", { kind: "a" });
    m.inc("texas_test_total", { kind: "a" }, 3);
    const text = m.render();
    expect(text).toContain("# TYPE texas_test_total counter");
    expect(text).toContain('texas_test_total{kind="a"} 4');
  });

  it("gauge 支持 set/inc/dec，counter 拒绝 dec", () => {
    const m = labelled();
    m.set("texas_test_gauge", 5);
    m.inc("texas_test_gauge");
    m.dec("texas_test_gauge");
    expect(m.render()).toContain("texas_test_gauge 5");
    expect(() => m.dec("texas_test_total", { kind: "a" })).toThrow(MetricsError);
  });

  it("histogram 累计分桶且渲染 _bucket/_sum/_count", () => {
    const m = labelled();
    m.observe("texas_test_hist", 0.02, { status: "OK" });
    m.observe("texas_test_hist", 0.3, { status: "OK" });
    const text = m.render();
    expect(m.countOf("texas_test_hist", { status: "OK" })).toBe(2);
    // 0.02 → 落在 0.001/0.002/0.005/0.01/0.025…各分桶；0.3 落在更大分桶。
    expect(text).toContain('texas_test_hist_bucket{status="OK",le="0.05"} 1');
    expect(text).toContain('texas_test_hist_bucket{status="OK",le="0.5"} 2');
    expect(text).toContain('texas_test_hist_bucket{status="OK",le="+Inf"} 2');
    expect(text).toContain('texas_test_hist_sum{status="OK"} 0.32');
    expect(text).toContain('texas_test_hist_count{status="OK"} 2');
  });

  it("负值/非有限观测被拒绝", () => {
    const m = labelled();
    expect(() => m.observe("texas_test_hist", -1, { status: "OK" })).toThrow(MetricsError);
    expect(() => m.set("texas_test_gauge", Number.NaN)).toThrow(MetricsError);
  });

  it("未注册指标、缺失标签与未声明标签均报错（防高基数漂移）", () => {
    const m = labelled();
    expect(() => m.inc("nope")).toThrow(MetricsError);
    expect(() => m.inc("texas_test_total", {})).toThrow(MetricsError);
    expect(() => m.inc("texas_test_total", { kind: "a", roomId: "r1" })).toThrow(MetricsError);
  });

  it("histogram 上的计数不落到 counter/gauge（误用报错）", () => {
    const m = labelled();
    expect(() => m.inc("texas_test_hist", { status: "OK" })).toThrow(MetricsError);
    expect(() => m.observe("texas_test_total", 1, { kind: "a" })).toThrow(MetricsError);
  });

  it("默认分桶单调、覆盖 0~10s SLO 关注区", () => {
    expect([...DEFAULT_BUCKETS_SECONDS].sort((a, b) => a - b)).toEqual([...DEFAULT_BUCKETS_SECONDS]);
    expect(DEFAULT_BUCKETS_SECONDS[0]).toBeLessThanOrEqual(0.001);
    expect(DEFAULT_BUCKETS_SECONDS[DEFAULT_BUCKETS_SECONDS.length - 1]).toBeGreaterThanOrEqual(10);
  });

  it("标签值转义（引号/反斜杠/换行）", () => {
    const m = labelled();
    m.inc("texas_test_total", { kind: 'a"b\\c\nd' });
    expect(m.render()).toContain('kind="a\\"b\\\\c\\nd"');
  });
});
