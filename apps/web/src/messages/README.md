# P0 messages

`zh-CN.ts` 是 P0 用户可见中文文案的单一入口。组件通过类型安全 key 读取文案；错误展示只按稳定 `ErrorCode` 映射，绝不按服务端 `message` 分支。

Hand History 的 `history.entries.tournamentEndNoChampion` 用于服务端明确投影无冠军的终局，客户端不从排名推断或补造冠军。

TEX-38 的 `table.feedback` 统一 Seat 动作、分池结果与服务端牌型的中文显示；`settings` 补充音量、减少动态效果和素材署名。牌型仅映射服务器 category，不运行本地牌型计算。

TEX-44 的 `brand` 命名空间集中首页、品牌导航、开局选择、表单引导与时间单位文案。页面展示不使用协议调试字段作为品牌文案。

TEX-45 补充牌桌游戏类型、盲注摘要、本人标记和行动提示文案；仍统一使用 `zh-CN.ts`。
