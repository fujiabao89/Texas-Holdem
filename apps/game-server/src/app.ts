import Fastify, { type FastifyInstance } from "fastify";

/**
 * 构建 Fastify 应用实例（不启动监听）。
 * 便于测试注入与后续任务注册路由/WebSocket 处理器。
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  return app;
}
