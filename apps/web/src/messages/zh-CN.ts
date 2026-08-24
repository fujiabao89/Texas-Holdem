import type { ErrorCode } from "@texas-holdem/protocol";

export const zhCN = {
  app: {
    title: "德州扑克",
    description: "极简、白色主体、响应式的德州扑克游戏",
  },
  navigation: {
    home: "首页",
    settings: "设置与规则",
  },
  home: {
    title: "德州扑克",
    introduction: "与朋友一起开始一场牌局。",
    createRoom: "创建房间",
    joinRoom: "加入房间",
  },
  shell: {
    pendingTitle: "功能准备中",
    pendingDescription: "此页面将在后续任务中完成。",
    backHome: "返回首页",
  },
  transport: {
    syncing: "正在同步最新牌局状态",
    disconnected: "连接已中断",
  },
  errors: {
    INVALID_MESSAGE: "客户端请求格式错误，请刷新页面后重试。",
    UNSUPPORTED_PROTOCOL_VERSION: "当前页面版本过旧，请刷新后继续。",
    AUTH_REQUIRED: "身份凭证已失效，请重新加入房间。",
    AUTH_FAILED: "身份凭证已失效，请重新加入房间。",
    FORBIDDEN: "你没有执行此操作的权限。",
    SESSION_REPLACED: "此牌局已在其他设备打开。",
    RATE_LIMITED: "操作过于频繁，请稍后重试。",
    ROOM_NOT_FOUND: "未找到该房间，请检查邀请码。",
    INVALID_INVITE_CODE: "邀请码格式不正确。",
    INVITE_EXPIRED: "邀请码已失效，请向房主获取新邀请。",
    ROOM_FULL: "房间已满，暂时无法加入。",
    NICKNAME_INVALID: "昵称需为 2–16 个字符。",
    NICKNAME_TAKEN: "该昵称已被使用，请换一个。",
    ROOM_LOCKED: "牌局已经开始，当前不能修改房间设置。",
    NOT_HOST: "只有房主可以执行此操作。",
    PLAYER_NOT_SEATED: "请先选择座位。",
    STALE_ROOM_STATE: "房间信息已更新，请重新确认操作。",
    TOURNAMENT_NOT_ACTIVE: "当前没有进行中的比赛。",
    NOT_YOUR_TURN: "当前还没轮到你行动。",
    INVALID_ACTION: "该操作已不可用，牌局状态已更新。",
    INVALID_AMOUNT: "下注金额不合法，请按最新范围重新选择。",
    ACTION_TIMEOUT: "操作超时，系统已自动处理。",
    STALE_GAME_STATE: "牌局状态已更新，请重新选择操作。",
    IDEMPOTENCY_KEY_REUSE: "请求状态异常，已重新同步，请再试一次。",
    TIME_BANK_DISABLED: "本场未启用延时。",
    TIME_BANK_EMPTY: "延时时间已用完。",
    TIME_BANK_NOT_AVAILABLE: "当前不能使用延时。",
    GAME_UNAVAILABLE: "牌桌正在恢复，请稍后重试。",
    INTERNAL_ERROR: "服务暂时异常，请稍后重试。",
  },
} as const;

export type MessageKey = DotPath<typeof zhCN>;

type DotPath<T, Prefix extends string = ""> = T extends string
  ? Prefix
  : { [K in keyof T & string]: DotPath<T[K], `${Prefix}${Prefix extends "" ? "" : "."}${K}`> }[keyof T & string];

function lookup(key: MessageKey): string {
  return key.split(".").reduce<unknown>((value, segment) => (value as Record<string, unknown>)[segment], zhCN) as string;
}

export function message(key: MessageKey): string {
  return lookup(key);
}

export function errorMessage(code: ErrorCode): string {
  return zhCN.errors[code];
}
