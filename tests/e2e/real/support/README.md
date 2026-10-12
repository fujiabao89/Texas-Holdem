# 真实链路夹具

`ui.ts` 只通过公开页面建房、加入、就座、准备与开始；时序建房可选择 15 秒行动和零 Time Bank。`run-identity.ts` 生成或一致续用中断运行的 runId、端口及 `tex_e2e_real_<runId>` schema；`launch-game-server.ts` 校验前缀并运行生产迁移/入口，`global-teardown.ts` 终止本次应用连接并删除该 schema。

时序配置注入 `TEX_TIMELINE_LOG` 时，启动器只保存 `timeline-evidence.ts` 白名单投影后的生产诊断行；其他 stdout 不写入该文件。不记录连接串、认证帧或牌面。生产入口的确定性 RNG 仅由测试环境启用；基准 seed 与 tournament 创建顺序共同决定实际洗牌，参见 [时序运行说明](../timeline/README.md)。

timeline 模式用 Node --import tsx 直接启动应用并保存匹配 schema 的 PID；timeline teardown 先停止本次应用，再调用既有 schema 清理。其他 real 套件维持原启动/teardown 路径。由 Playwright 配置管理进程；不要手动同时启动两个 real 配置或复用生产数据库。夹具遵守 [06 §9.3](../../../../docs/06-testing-strategy.md#93-tex-62-牌局时序与弱网真实链路门禁实施要求) 的真实链路与隔离要求，完整说明见 [E2E README](../../README.md)。

配置必须使用 writeRunIdentity 返回的实际身份，不能在旧文件仍存在时另用新 schema。不同端口的并发运行明确拒绝；身份一致性与中断续用由 tests/support/run-identity.test.ts 使用独立临时文件验证。
