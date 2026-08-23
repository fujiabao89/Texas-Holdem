import { createHash } from "node:crypto";

/**
 * checksum 工具（docs/03-data-model.md §5.7/§5.9）。
 *
 * - `stableStringify`：canonical JSON 序列化——对象键按字典序递归排序、
 *   无多余空白，使同一逻辑内容恒产生同一字节序列（checksum 输入可重现）。
 * - BigInt 序列化为十进制数字（sequence/筹码在 Node 侧是 bigint，§5.9 数值边界）。
 * - `sha256`：32 字节摘要，用于 `game_snapshots.state_checksum`（对 state 的
 *   canonical JSON）与 `commit_checksum`（对整个提交单元的 canonical JSON，
 *   由调用方组装：Hand 元数据、按序 Events、Snapshot 状态及相关结果变更；
 *   排除 DB 自动生成的 identity/created_at，包含 Tournament/Hand/Sequence
 *   等自然幂等键，§5.7）。
 */

export function stableStringify(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("stableStringify: number must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean" || typeof value === "undefined") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`).join(",")}}`;
  }
  throw new TypeError(`stableStringify: unsupported type ${typeof value}`);
}

/** 对 canonical JSON 计算 32 字节 SHA-256。 */
export function sha256Checksum(value: unknown): Buffer {
  return createHash("sha256").update(stableStringify(value), "utf8").digest();
}
