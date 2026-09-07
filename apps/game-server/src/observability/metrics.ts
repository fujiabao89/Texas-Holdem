/**
 * 极简 Prometheus 文本协议指标注册表（TEX-29）。
 *
 * 设计约束（docs/06 §10.2 与监控红线）：
 * - 禁止把 roomId/playerId/requestId/connectionId 等无限增长标识作为标签值——
 *   定位交给脱敏日志/告警关联信息；本模块在定义层就锁死 labelNames，观测时
 *   标签集合必须与定义完全一致，防止意外引入高基数标签。
 * - Counter 单调递增、Gauge 可增可减、Histogram 记录观测值并给出固定分桶；
 *   渲染为 Prometheus text/plain exposition（供 Prometheus 抓取，quantile 由
 *   Prometheus `histogram_quantile` 计算，本模块不自行估算）。
 * - 零第三方依赖：语义明确、可单测，避免为指标引入运行期依赖。
 */

export type Labels = Readonly<Record<string, string>>;

export type MetricKind = "counter" | "gauge" | "histogram";

/** 历史/延迟观测固定分桶（秒）。覆盖 Action→Event、重连恢复等 SLO 关注区。 */
export const DEFAULT_BUCKETS_SECONDS: readonly number[] = [
  0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5,
  0.75, 1, 1.5, 2, 3, 5, 10,
] as const;

export interface MetricDef {
  readonly name: string;
  readonly help: string;
  readonly kind: MetricKind;
  readonly labelNames: readonly string[];
  /** 仅 histogram：分桶（秒），必须单调递增。缺省用 DEFAULT_BUCKETS_SECONDS。 */
  readonly bucketsSeconds?: readonly number[];
}

export class MetricsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricsError";
  }
}

const LABEL_SEP = "\u001f";
const LE_SEP = "\u001e";

function sampleKey(labelNames: readonly string[], labels: Labels): string {
  if (labels === undefined || labels === null) {
    throw new MetricsError("labels are required");
  }
  if (labelNames.length === 0) {
    if (Object.keys(labels).length !== 0) {
      throw new MetricsError("metric does not declare labels but labels were provided");
    }
    return "";
  }
  const parts: string[] = [];
  for (const name of labelNames) {
    const value = labels[name];
    if (value === undefined) {
      throw new MetricsError(`metric is missing required label ${name}`);
    }
    // 位置编码（顺序与 labelNames 对齐），避免 value 内含 '=' 时重建错位。
    parts.push(value);
  }
  for (const key of Object.keys(labels)) {
    if (!labelNames.includes(key)) {
      throw new MetricsError(`metric received undeclared label ${key}`);
    }
  }
  return parts.join(LABEL_SEP);
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

interface SampleStore {
  readonly def: MetricDef;
  readonly buckets: readonly number[];
  /** counter/gauge 的样本值；histogram 的每个分桶（le）计数。 */
  readonly samples: Map<string, number>;
  readonly sum: Map<string, number>;
  readonly count: Map<string, number>;
}

function sanitizeName(name: string): void {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
    throw new MetricsError(`invalid metric name ${JSON.stringify(name)}`);
  }
}

/**
 * 服务端指标注册表。通过 `register` 预注册指标定义，随后用 `inc/dec/set/observe`
 * 记录；`render` 输出 Prometheus text exposition。指标名即唯一标识，重复注册报错。
 */
export class Metrics {
  private readonly stores = new Map<string, SampleStore>();

  register(def: MetricDef): void {
    sanitizeName(def.name);
    if (this.stores.has(def.name)) {
      throw new MetricsError(`metric ${def.name} is already registered`);
    }
    const buckets =
      def.kind === "histogram"
        ? [...(def.bucketsSeconds ?? DEFAULT_BUCKETS_SECONDS)].sort((a, b) => a - b)
        : [];
    if (def.kind === "histogram" && buckets.length === 0) {
      throw new MetricsError(`histogram ${def.name} requires buckets`);
    }
    this.stores.set(def.name, {
      def,
      buckets,
      samples: new Map(),
      sum: new Map(),
      count: new Map(),
    });
  }

  private store(name: string): SampleStore {
    const store = this.stores.get(name);
    if (store === undefined) {
      throw new MetricsError(`metric ${name} is not registered`);
    }
    return store;
  }

  private key(name: string, labels: Labels): { store: SampleStore; key: string } {
    const store = this.store(name);
    return { store, key: sampleKey(store.def.labelNames, labels) };
  }

  inc(name: string, labels: Labels = {}, amount = 1): void {
    if (amount < 0) throw new MetricsError("inc amount must be non-negative");
    const { store, key } = this.key(name, labels);
    if (store.def.kind === "histogram") {
      throw new MetricsError(`metric ${name} is a histogram; use observe()`);
    }
    store.samples.set(key, (store.samples.get(key) ?? 0) + amount);
  }

  dec(name: string, labels: Labels = {}, amount = 1): void {
    if (amount < 0) throw new MetricsError("dec amount must be non-negative");
    const { store, key } = this.key(name, labels);
    if (store.def.kind === "counter") {
      throw new MetricsError(`counter ${name} must only increase; use gauge for dec`);
    }
    store.samples.set(key, (store.samples.get(key) ?? 0) - amount);
  }

  set(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) throw new MetricsError(`gauge ${name} requires a finite value`);
    const { store, key } = this.key(name, labels);
    if (store.def.kind !== "gauge") {
      throw new MetricsError(`metric ${name} is not a gauge; use inc/dec/observe`);
    }
    store.samples.set(key, value);
  }

  observe(name: string, valueSeconds: number, labels: Labels = {}): void {
    if (!Number.isFinite(valueSeconds) || valueSeconds < 0) {
      throw new MetricsError(`histogram ${name} requires a non-negative finite observation`);
    }
    const { store, key } = this.key(name, labels);
    if (store.def.kind !== "histogram") {
      throw new MetricsError(`metric ${name} is not a histogram`);
    }
    for (const bound of store.buckets) {
      if (valueSeconds <= bound) {
        const sampleKey = `${key}${LE_SEP}${bound}`;
        store.samples.set(sampleKey, (store.samples.get(sampleKey) ?? 0) + 1);
      }
    }
    const infKey = `${key}${LE_SEP}+Inf`;
    store.samples.set(infKey, (store.samples.get(infKey) ?? 0) + 1);
    store.sum.set(key, (store.sum.get(key) ?? 0) + valueSeconds);
    store.count.set(key, (store.count.get(key) ?? 0) + 1);
  }

  countOf(name: string, labels: Labels = {}): number {
    const { store, key } = this.key(name, labels);
    return store.def.kind === "histogram" ? (store.count.get(key) ?? 0) : (store.samples.get(key) ?? 0);
  }

  render(): string {
    const lines: string[] = [];
    for (const { def, samples, sum, count } of this.stores.values()) {
      lines.push(`# HELP ${def.name} ${def.help}`);
      lines.push(`# TYPE ${def.name} ${def.kind === "histogram" ? "histogram" : def.kind}`);
      if (def.kind === "histogram") {
        const grouped = new Map<string, string[]>();
        const seenKeyOrder: string[] = [];
        for (const [sampleKey, value] of samples) {
          const sep = sampleKey.indexOf(LE_SEP);
          const key = sep === -1 ? "" : sampleKey.slice(0, sep);
          const le = sep === -1 ? "+Inf" : sampleKey.slice(sep + 1);
          const encoded = this.encodeLabels(this.labelsFor(def, key));
          const line = `${def.name}_bucket{${encoded.length === 0 ? "" : `${encoded},`}le="${le}"} ${value}`;
          const bucketLines = grouped.get(key) ?? [];
          if (bucketLines.length === 0) seenKeyOrder.push(key);
          bucketLines.push(line);
          grouped.set(key, bucketLines);
        }
        for (const key of seenKeyOrder) {
          const encoded = this.encodeLabels(this.labelsFor(def, key));
          const prefix = `${def.name}`;
          for (const line of (grouped.get(key) ?? []).sort((a, b) => a.localeCompare(b))) {
            lines.push(line);
          }
          lines.push(`${prefix}_sum{${encoded}} ${sum.get(key) ?? 0}`);
          lines.push(`${prefix}_count{${encoded}} ${count.get(key) ?? 0}`);
        }
        continue;
      }
      const encodedCache = new Map<string, string>();
      for (const [sampleKey, value] of samples) {
        const labels = this.labelsFor(def, sampleKey);
        const encoded = encodedCache.get(sampleKey) ?? this.encodeLabels(labels);
        encodedCache.set(sampleKey, encoded);
        const labelBlock = encoded === "" ? "" : `{${encoded}}`;
        lines.push(`${def.name}${labelBlock} ${Number.isInteger(value) ? value : value.toFixed(6)}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  private labelsFor(def: MetricDef, key: string): Labels {
    if (def.labelNames.length === 0) return {};
    if (key === "") {
      return def.labelNames.reduce<Record<string, string>>((acc, name) => {
        acc[name] = "";
        return acc;
      }, {});
    }
    const values = key.split(LABEL_SEP);
    const labels: Record<string, string> = {};
    def.labelNames.forEach((name, index) => {
      labels[name] = values[index] ?? "";
    });
    return labels;
  }

  private encodeLabels(labels: Labels): string {
    const entries = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
    return entries.length === 0 ? "" : entries.join(",");
  }
}

export function createMetrics(defs: readonly MetricDef[]): Metrics {
  const metrics = new Metrics();
  for (const def of defs) metrics.register(def);
  return metrics;
}

/** 组件观测用句柄：仅暴露记录操作，不暴露渲染（渲染归 /metrics 端点所有）。 */
export type MetricsObserver = Pick<Metrics, "inc" | "dec" | "set" | "observe">;
