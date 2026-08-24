/**
 * HTTP Bearer 鉴权（docs/02-protocol-spec.md §4.2/§5）。
 *
 * 从 `Authorization: Bearer <playerToken>` 提取 token；playerId 由服务端
 * 经 token 摘要反查（RoomManager.authenticate），不信任请求携带的身份。
 * token 不进入 URL、查询参数或日志。
 *
 * 刻意不使用正则解析：`authorization` 是用户可控输入，正则回溯可能被
 * 超长空白串触发 ReDoS（CodeQL：polynomial regular expression on
 * uncontrolled data）；前缀检查为线性时间。
 */

export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const value = authorization.trim();
  if (value.length <= 7 || !value.toUpperCase().startsWith("BEARER ")) return undefined;
  const token = value.slice(7).trim();
  return token.length > 0 ? token : undefined;
}
