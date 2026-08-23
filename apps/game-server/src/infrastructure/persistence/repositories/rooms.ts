import { eq } from "drizzle-orm";
import type { Database, GameTransaction } from "../database";
import { rooms, roomPlayers } from "../schema";
import { validateDisplayName, normalizeDisplayNameKey } from "../display-name";

/**
 * Room 控制面仓储（docs/03-data-model.md §5.1/§5.2/§7.2）。
 *
 * 只提供控制面所需的最小原子写入：Room + 首个 Host 在同一事务提交。
 * 大厅业务（加入/离开/踢人/Host 转移/邀请码限流）属 TEX-19，不在本仓储。
 */

export type RoomMode = "MULTIPLAYER" | "SINGLE_PLAYER";

/** 创建 Room 与首个 Host 的输入。所有 id 由调用方预生成（幂等重试的前提）。 */
export interface CreateRoomWithHostInput {
  readonly roomId: string;
  readonly mode: RoomMode;
  /** MULTIPLAYER 必填（6 位大写字母/数字、排除易混淆字符）；SINGLE_PLAYER 必须为 null。 */
  readonly inviteCode: string | null;
  readonly configJson: unknown;
  readonly host: {
    readonly playerId: string;
    readonly displayName: string;
    /** HUMAN 的凭证摘要（computePlayerTokenDigest 产物）与密钥版本。 */
    readonly tokenDigest: Buffer;
    readonly tokenKeyId: string;
  };
}

export interface RoomRepository {
  /**
   * 单事务写入 Room + 首个 Host（§5.1 的三步顺序）：
   * 1. 插入 `rooms`（host_player_id = NULL）；
   * 2. 插入 `room_players`（Host 身份，含 token 摘要）；
   * 3. 回填 `rooms.host_player_id`。
   * DEFERRABLE 复合外键在提交时才检查 Host 属于本 Room。
   */
  createRoomWithHost(input: CreateRoomWithHostInput): Promise<void>;
}

export function createRoomRepository(database: Database): RoomRepository {
  async function createRoomWithHost(input: CreateRoomWithHostInput): Promise<void> {
    validateDisplayName(input.host.displayName);
    const displayNameKey = normalizeDisplayNameKey(input.host.displayName);
    await database.withTransaction(async (tx: GameTransaction) => {
      await tx.insert(rooms).values({
        id: input.roomId,
        mode: input.mode,
        inviteCode: input.inviteCode,
        status: "CREATED",
        configJson: input.configJson,
        hostPlayerId: null,
      });
      await tx.insert(roomPlayers).values({
        id: input.host.playerId,
        roomId: input.roomId,
        displayName: input.host.displayName,
        displayNameKey,
        kind: "HUMAN",
        tokenDigest: input.host.tokenDigest,
        tokenKeyId: input.host.tokenKeyId,
        status: "ACTIVE",
      });
      await tx.update(rooms).set({ hostPlayerId: input.host.playerId }).where(eq(rooms.id, input.roomId));
    });
  }

  return { createRoomWithHost };
}
