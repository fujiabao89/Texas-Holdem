# Animations

对服务端**已连续应用**的 Event 进行排队和呈现。`AnimationQueue` 从 `ProjectionStore.subscribeAcceptedGameEvents` 接收 `{ message, afterCanonical }`，只维护 presentation state；取消、异常、超时和 Reduced Motion 均提交终帧。Snapshot/重连通知是屏障，清空旧任务且不回放断线期间事件；Hard Fast Forward 仅请求既有的权威 Snapshot，绝不发送游戏 Action。
