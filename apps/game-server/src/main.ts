import { buildApp } from "./app";

const rawPort = process.env.PORT ?? "3001";
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
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
