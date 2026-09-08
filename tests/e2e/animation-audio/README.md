# 动画与音效回归（TEX-38）

`experience.spec.ts` 使用真实 Chromium、现有可观测性门禁和合法 WS 投影 fixture，覆盖：

- 设置页纯键盘静音、音量与减少动态效果，以及刷新/牌桌入口的偏好一致性。
- 注入浏览器 autoplay、播放和加载失败后，事件 sequence 与键盘下注继续可用。
- Flop/Turn/River 终帧、连续两位玩家摊牌的动画节点重建，以及只展示服务端最佳五张。
- 系统减少动态效果下，公开牌型、最佳五张、主池/边池及平分金额保持可读。
- 模拟 `visibilitychange` 后取消旧动画/声音，返回时请求权威 Snapshot，新事件正常恢复。
- 360/390/1366 像素十人桌横向边界、座位矩形两两不相交、下注点击和完整页面截图。
- Chromium CDP 6x CPU 限速下，十人桌公共牌动画期间仍能提交正确 sequence 的下注；记录 90 个真实 rAF 帧间隔、是否自动降级和自动化点击至命令观察耗时。
- 设置页与减少动态效果公开结果的 axe critical/serious 门禁；非完整 WCAG 认证。

## 运行

```powershell
$env:TEX_E2E_PORT = '3138'
pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/animation-audio/experience.spec.ts --workers=1
```

无重试。需要 Node/pnpm 与已安装的 Playwright Chromium；不依赖 game-server 或 PostgreSQL。时序回归使用 Playwright Clock，CPU 采样使用真实 rAF，没有固定 sleep。成功截图保存在 `output/playwright/TEX-38-*.png`，并作为附件进入现有 `.artifacts`；CPU 报告作为 JSON 附件和 `[TEX-38-CPU-6X]` 运行输出保留。失败 trace/视频和浏览器错误由共享配置/fixture 处理。

CPU 采样只报告当前机器和浏览器条件下的帧间隔，不将 CDP 6x 等同于指定 Android/iPhone，也不要求高性能主机必然触发慢帧降级。持续慢帧的确定性阈值由 `FrameHealth` 单元测试覆盖；本浏览器用例在真实受限 CPU 下验证事件终帧与操作可达性。点击至命令耗时包含自动化开销，不作为原生输入延迟的精确测量。

`table-fixture.ts` 只经真实 WS 客户端入口发送 Schema 校验消息；不导入或修改浏览器投影 store。音频使用可控的浏览器 Audio 替身定位失败降级与取消行为，不证明实际编码支持、听感、真实浏览器自动播放策略或设备性能。模拟 visibility 和 viewport 也不替代手机系统后台、真实移动网络及实机动画验收；这些仍按 [测试权威规格](../../../docs/06-testing-strategy.md) §9 验证。
