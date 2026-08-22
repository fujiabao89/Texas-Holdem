import { buildApp } from "./app";

const port = Number(process.env.PORT ?? "3001");
const host = process.env.HOST ?? "0.0.0.0";

const app = buildApp();

app.listen({ port, host }, (err, address) => {
  if (err) {
    // buildApp() 使用 logger: false，app.log.error 是 no-op；启动失败需落到 stderr。
    console.error(`game-server failed to start on ${host}:${port}`, err);
    process.exit(1);
  }
  console.log(`game-server listening at ${address}`);
});
