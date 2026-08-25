# scheduler（TEX-20）

可注入 Timer Scheduler 接口与生产实现。权威规格：docs/04-game-server-architecture.md §8。

- `TimerScheduler`：`setTimeout(callback, delayMs) → {id}` / `clearTimeout(handle)`。执行器通过它调度行动超时、断线宽限与定时升盲任务；Timer 到期只投递队列命令，不直接 mutate（§8.2）。
- `createNodeTimerScheduler()`：生产实现，包装 Node `setTimeout`/`clearTimeout`。
- 测试注入 `tests/support/fake-clock.ts`（FakeClock 满足 `TimerScheduler` 形状）：手动 `advance`、按到期顺序执行、`pendingTimers()` 断言无泄漏，实现 deterministic 时间推进，不依赖真实时钟/sleep。

取消依赖 generation 失效而非底层 `clearTimeout` 是否及时（§8.2）：即使回调已在事件循环等待，执行前复核 `handId/actor/deadline/generation`，不匹配即 stale no-op。
