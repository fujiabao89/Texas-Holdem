# Create room scenario

创建房间及其初始可见状态的端到端场景。
# Create room / Lobby E2E

TEX-24 覆盖 Home 的双入口与邀请链接仅预填邀请码的可访问性回归。HTTP/WS Transport
的创建、加入、Lobby 投影、断线和权限边界使用可注入 fake 做 Unit 测试；真实服务端
多人联调由 TEX-28 覆盖。

TEX-44：`brand-experience.spec.ts` 覆盖首页原生开局选择的键盘导航、移动端/桌面无横向溢出、axe serious/critical、减少动态效果、历史抽屉焦点和受控赛果投影。`flows.spec.ts` 保留创建与幂等回归，首页断言按已批准品牌入口更新。运行 `pnpm exec playwright test -c tests/e2e/playwright.config.ts create-room smoke --workers=2`。
