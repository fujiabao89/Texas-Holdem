# Settings feature

设置与规则页（TEX-27，docs/05 §6.7）：`/settings` 上的全局音效开关与静态规则说明。

- `settings-page-content.tsx` — 音效开关读写 `state/ui-state.ts` 的 `soundEnabledAtom` 并以 `localStorage` 持久化（Hydration 安全：SSR 与首次客户端渲染输出一致）；规则说明为静态文案。

本页不保存任何牌局状态、Token 或他人信息；动画/动态偏好仍由 TEX-26 的偏好接口承载，此处只复用既有全局开关。
