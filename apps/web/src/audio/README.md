# Audio controller

本地音效控制器。`AudioController` 只播放 `/public/audio/` 下的 Kenney CC0 MP3，音效开关是纯 UI 状态；自动播放解锁或播放失败静默降级，不影响牌局。浏览器适配器为每个短音效复用四个预加载 voice，避免连续发牌反复解码造成卡顿；一条 `FLOP_DEALT` 仍是唯一权威事件，但在已开始的展示任务内按三张牌到位节奏播放三个本地 cue。素材来源、原始包、许可证和 SHA-256 见 `public/audio/THIRD_PARTY_NOTICES.md`。
