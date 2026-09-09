# Settings feature

设置与规则页（TEX-27/TEX-38，docs/05 §6.7、§10.3）：`/settings` 上的全局音效开关、音量、动态效果和静态规则说明。

- `settings-page-content.tsx` — 通过 `state/use-presentation-preferences.ts` 与牌桌共用偏好，音量为原生 0–100 Slider，动态效果为 system/reduce Select；所有控件具备可访问名称、键盘操作和持久化。规则说明为静态文案，保留 Kenney 素材署名。

本页不保存任何牌局状态、Token 或他人信息。偏好单元测试在 `state/presentation-preferences.test.ts`；键盘、刷新与牌桌同步回归在 `tests/e2e/animation-audio/experience.spec.ts`。

TEX-44 使用共享品牌导航和暖白分区；控件仍操作同一个 presentation preference store。动态效果偏好同时覆盖产品首页、路由入场、开局弹层和历史抽屉。
