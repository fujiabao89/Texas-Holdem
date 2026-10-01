# 座位稳定性 E2E（TEX-47）

通过 Playwright WebSocket mock 注入合法投影，验证座位视觉映射与 D/SB/BB 标识；不依赖真实 game-server、数据库或 sleep。

- `table-fixture.ts`：构造 2–10 人的 `GameSnapshot`/`RoomSnapshot` 并按序驱动 `GAME_EVENT`；`seatTableSnapshot` 可指定 viewer、Dealer、SB、BB 与当前行动者座位。
- `stable-seats.spec.ts`：
  - Heads-up：D=SB 同座、BB 独立；弃牌与跨手 Dealer/盲注移动后 `data-seat-slot` 完全不变。
  - 6 人：按相对本人 `seatIndex` 顺序填入六人模板；双人面对面，十人使用完整环形模板（TEX-46 整体布局更新）。行动者切换与玩家淘汰不移动座位，模板按完整名单而非存活人数选择。
  - 10 人 360×800 与 390×844：10 个唯一槽位、座位矩形互不相交、D/SB/BB 徽标不遮挡昵称/筹码/底牌、无横向溢出；长昵称与大额筹码仍可区分座位与盲注。
  - 跨手：`HAND_STARTED` 移动 D/SB/BB 徽标但不改变任何座位的槽位。

```bash
pnpm exec playwright test -c tests/e2e/playwright.config.ts seats
# 并行开发时可用 TEX_E2E_PORT=3139 隔离端口
```

断言只依赖 `data-seat`、`data-seat-slot`、`data-active`、`data-seat-badge`、`data-seat-name`、`data-seat-stack` 等稳定语义属性，不依赖 CSS class 或固定像素坐标。

夹具拦截 `**/api/v1/ws`，兼容同源代理和开发环境独立 game-server 地址；不会连接真实牌局。
