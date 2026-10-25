<div align="center">

![River & Raise — The friends’ table](../docs/assets/readme-banner.svg)

# River & Raise

**好牌，不如好牌友。**

一张私人牌桌，2–10 位朋友。从第一手试探，到最后一张河牌。

[![CI](https://github.com/fujiabao89/Texas-Holdem/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fujiabao89/Texas-Holdem/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-214D3E?style=flat-square)](../package.json)
[![License](https://img.shields.io/badge/License-Apache%202.0-C44E2B?style=flat-square)](../LICENSE)

**[在线体验](https://riverandraise.app)** · **[本地运行](../README.md#本地运行)** · **[工程文档](../docs/README.md)** · **[参与贡献](../CONTRIBUTING.md)**

</div>

---

![River & Raise 产品首页：暖白页面、扑克牌与深绿筹码](../docs/assets/home-desktop.jpg)

## 少一点准备，多一点牌局

River & Raise 是面向朋友小聚的中文 No-Limit Texas Hold’em Web 游戏：无需下载，用邀请码相聚，选好座位就能开始。

| 体验           | 留给牌友的细节                                      |
| -------------- | --------------------------------------------------- |
| **♠ 私人主场** | 2–10 位朋友，邀请码相聚，选座、准备后开局。         |
| **♥ 完整赛程** | 单桌 Freezeout 锦标赛，支持全下、边池、淘汰与排名。 |
| **♣ 牌桌细节** | 发牌翻牌、筹码反馈与可调音效；支持减少动态效果。    |
| **♦ 断线续局** | 状态由服务端同步，重连后有序恢复。                  |
| **♠ 回看牌局** | 当前玩家视角的手牌历史、时间线与权限过滤赛果。      |
| **♥ 规则验证** | 独立扑克引擎、可复现模拟与真实链路测试。            |

**只玩模拟筹码，无现金价值。** 当前处于 P0 持续完善阶段，发布验收状态见 [任务总览](../docs/00-project/p0-task-overview.md)。

## 为下一位开发者留好座位

前端使用 **Next.js / React / Tailwind CSS**，实时服务使用 **Fastify / WebSocket**，数据通过 **Drizzle ORM** 保存到 **PostgreSQL**。规则引擎与通信协议分别维护，客户端展示服务端投影。

| 你想做什么   | 从这里开始                                                           |
| ------------ | -------------------------------------------------------------------- |
| 在本机运行   | [开发者 README：环境、配置、迁移与启动](../README.md#本地运行)       |
| 理解项目     | [工程结构](../README.md#工程结构) · [权威规格](../docs/README.md)    |
| 运行验证     | [测试命令](../README.md#验证与测试) · [测试指南](../tests/README.md) |
| 参与开发     | [贡献约定](../CONTRIBUTING.md) · [Agent 协作](../AGENTS.md)          |
| 报告安全问题 | [安全策略与私密披露](../SECURITY.md)                                 |

<details>
<summary>GitHub 配置与自动化维护</summary>

本文件同时承担 GitHub 仓库首页展示入口；完整的本地运行与开发指南维护在[根 README](../README.md)，避免复制启动步骤。GitHub 会优先显示 `.github/README.md`，修改首页时应检查这两个入口的导航。

本目录保存工作流、代码所有权、PR 模板与仓库治理配置。维护入口：[工作流说明](./workflows/README.md)、[PR 策略](./PULL_REQUEST_POLICY.md)、[CODEOWNERS](./CODEOWNERS)、[分支保护说明](./RULESET.md)。

</details>

---

<div align="center">

**The table is yours.**

[叫上朋友，开一局 ↗](https://riverandraise.app)

[Apache License 2.0](../LICENSE) · [第三方音效许可](../apps/web/public/audio/THIRD_PARTY_NOTICES.md)

</div>
