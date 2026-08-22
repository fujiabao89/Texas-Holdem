# Poker engine source

引擎实现根目录。所有随机性必须通过可注入接口取得，生产环境使用安全随机源。

## 当前已实现（TEX-13）

- `cards/` —— 牌、牌堆、随机源与牌型评估（Card / Deck / RandomSource / Hand Evaluator）。

## 尚待落地

`rules/`、`engine/`、`pot/`、`events/`、`timer/` 目前为空目录说明，待 TEX-14 / TEX-15 填充。规则与接口定义一律链接 [docs/01-engine-spec.md](../../../docs/01-engine-spec.md)，不在子 README 重复。
