/**
 * 产物脱敏过滤（TEX-29）。
 *
 * 压测运行本身不采集/不落盘任何敏感值（docs/06 §10.2 红线：Token、完整 Deck、
 * 未公开底牌、AI 隐藏 Reasoning 禁止进入存储）。本模块是对产物 JSON 的**防御性
 * 收尾**：递归删除键名命中敏感词的值，并把明显的 Bearer 授权串替换为占位符，
 * 保证即使未来某处意外带出字段也不会进入 Artifact / 日志。
 */
export const SENSITIVE_KEY_PATTERN =
  /token|secret|hmac|authorization|password|credential|deck|hole|burn|reasoning/i;

/** 值级占位：显式 Bearer 授权串。替换用全局标志（同串多 Token 全部命中）；检测用非全局。 */
const BEARER_PATTERN_GLOBAL = /Bearer\s+\S+/gi;
const BEARER_PATTERN_DETECT = /Bearer\s+\S+/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** 递归脱敏：命中键删除、Bearer 串替换；返回全新结构（不就地修改入参）。 */
export function redactJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (typeof value === "string") {
    // 占位符不含 "Bearer " 前缀，避免自身再次命中检测正则（写盘前扫描依赖它）。
    return BEARER_PATTERN_DETECT.test(value) ? value.replace(BEARER_PATTERN_GLOBAL, "[REDACTED]") : value;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) continue;
      out[key] = redactJson(child);
    }
    return out;
  }
  return value; // number / boolean
}

/**
 * 扫描任意值，返回仍命中的敏感键路径（"a.b"）。产物写入前调用：非空即拒绝写盘
 * 并输出路径（findings 用）。不会把字符串值内部的随机 Token 误判为泄露——脱敏
 * 依赖键名与 Bearer 前缀，采集侧不引入敏感值才是第一道防线。
 */
export function sensitiveKeysIn(value: unknown, path = ""): string[] {
  const found: string[] = [];
  if (value === null || value === undefined) return found;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      found.push(...sensitiveKeysIn(value[i], `${path}[${i}]`));
    }
    return found;
  }
  if (typeof value === "string") {
    if (BEARER_PATTERN_DETECT.test(value)) found.push(`${path}[:Bearer]`);
    return found;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = path === "" ? key : `${path}.${key}`;
      if (isSensitiveKey(key)) found.push(next);
      found.push(...sensitiveKeysIn(child, next));
    }
  }
  return found;
}
