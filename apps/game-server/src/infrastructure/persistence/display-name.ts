/**
 * 展示昵称（display_name）服务端校验与规范化键（docs/03-data-model.md §5.2）。
 *
 * - 长度按 Unicode grapheme clusters 计（2–16），不是 UTF-16 code unit；
 * - 拒绝控制字符（\p{Cc}，如换行/制表）；ZWJ 等 emoji 组合字符合法；
 * - `normalizeDisplayNameKey`：NFKC + 小写折叠，作为 `display_name_key`
 *   防止规范化/大小写意义上的重名。JS `toLowerCase` 是简单大小写映射，
 *   不完全等价 Unicode full case-fold；规格明示"不声称防御所有 Unicode
 *   同形字"（§5.2），此实现覆盖常见重名（大小写/全半角/NFKC 等价）。
 */

export const DISPLAY_NAME_MIN_GRAPHEMES = 2;
export const DISPLAY_NAME_MAX_GRAPHEMES = 16;

export class DisplayNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisplayNameError";
  }
}

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export function countDisplayNameGraphemes(displayName: string): number {
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  let count = 0;
  for (const _ of segmenter.segment(displayName)) {
    count += 1;
  }
  return count;
}

/** 入库前校验：长度 2–16 个 grapheme clusters 且不含控制字符。 */
export function validateDisplayName(displayName: string): void {
  const graphemes = countDisplayNameGraphemes(displayName);
  if (graphemes < DISPLAY_NAME_MIN_GRAPHEMES || graphemes > DISPLAY_NAME_MAX_GRAPHEMES) {
    throw new DisplayNameError(
      `display name must be ${DISPLAY_NAME_MIN_GRAPHEMES}-${DISPLAY_NAME_MAX_GRAPHEMES} grapheme clusters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(displayName)) {
    throw new DisplayNameError("display name must not contain control characters");
  }
}

/** 计算 `room_players.display_name_key`（NFKC + 小写折叠）。 */
export function normalizeDisplayNameKey(displayName: string): string {
  return displayName.normalize("NFKC").toLowerCase();
}
