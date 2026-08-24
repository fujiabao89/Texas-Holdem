/**
 * HTTP Bearer 鉴权（docs/02-protocol-spec.md §4.2/§5）。
 *
 * 从 `Authorization: Bearer <playerToken>` 提取 token；playerId 由服务端
 * 经 token 摘要反查（RoomManager.authenticate），不信任请求携带的身份。
 * token 不进入 URL、查询参数或日志。
 */

export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1];
}
