# Shared components

跨多个功能使用的纯展示型 UI 组件；不得包含特定牌局业务状态。

TEX-44：`site-chrome.tsx` 负责品牌导航、页脚、跳转至正文与 300ms 页面入场；`start-game-button.tsx` 使用原生 dialog 提供创建/加入选择、焦点约束和 Esc 关闭；`poker-art.tsx` 为首页独立装饰，仅更新 CSS 倾斜变量，遵从系统和既有设备动态偏好。以上组件不创建网络连接或读取私有牌。
