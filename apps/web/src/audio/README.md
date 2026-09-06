# Audio controller

TEX-38：浏览器适配器使用 `HTMLAudioElement`，非 AudioContext。控制器读取统一设备偏好，支持实时主音量、键盘/Pointer 解锁、减少动态时即时 cue、90ms 普通重复提示合并。自动播放被拒后只在下一次手势重试，不补播旧事件；播放和解锁均有 5 秒清理期限。卸载释放元素、listener 和 timer，支持 Strict Mode 重挂载。

`TableCueTracker` 只观察已接受的 canonical sequence，提示新的本人行动机会与盲注级别；Snapshot、隐藏或重连重建基线，不把旧状态当新提醒。提醒低优先级、最多等待 900ms，不能抢占牌声或其他控制器；服务端公开获胜牌型仅改变既有派奖采样的速率与相对音量，不自行评牌。`browser-audio-adapter.test.ts`、`table-cues.test.ts` 和 `audio-controller.test.ts` 覆盖生命周期、降级与节拍，运行 `pnpm exec vitest run --project unit apps/web/src/audio --maxWorkers 1`。

本地音效控制器。`AudioController` 只播放 `/public/audio/` 下的 Kenney CC0 MP3，音效开关是纯 UI 状态；自动播放解锁或播放失败静默降级，不影响牌局。同一页面的所有牌桌控制器共享一个独占通道，新 cue 到来时先停止旧 cue 再立即播放；标签页转入后台时立即停止当前及延迟 cue，避免多个牌桌标签同时出声。关闭音效、Snapshot/重连屏障、Hard Fast Forward 或卸载时也会清除当前与排队声音。一条 `FLOP_DEALT` 仍是唯一权威事件，但在已开始的展示任务内按三张牌实际落入目标框、翻开的节奏播放三个本地 cue，Turn/River 也在落牌而非收 Event 时播放。节拍从 `animations/timings.ts` 读取，避免音画漂移。素材来源、原始包、许可证和 SHA-256 见 `public/audio/THIRD_PARTY_NOTICES.md`。

动作音色彼此独立：过牌为双击木桌，跟注为单枚落筹，普通下注为短推筹，加注使用用户选定的“散落 8”，All-in 使用“散落 9”，弃牌使用推牌声，派奖和终局分别使用不同的筹码堆叠声。发底牌与公共牌采用用户选定的方案 A 轻柔牌声；盲注也使用独立的短筹码声。
