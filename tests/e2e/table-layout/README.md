# Table layout E2E

single-viewport.spec.ts 验证手机/平板/桌面牌桌布局、行动区域与全下确认的可访问性。使用权威投影 mock，不计算扑克规则；TEX-60 通过共享 fixtures/time-sync.ts 显式回复 wire v6 校时。

运行：pnpm exec playwright test -c tests/e2e/playwright.config.ts table-layout --workers=1。校时/弱网行为由 betting 套件覆盖。
