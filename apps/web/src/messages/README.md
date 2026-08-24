# P0 messages

`zh-CN.ts` 是 P0 用户可见中文文案的单一入口。组件通过类型安全 key 读取文案；错误展示只按稳定 `ErrorCode` 映射，绝不按服务端 `message` 分支。
