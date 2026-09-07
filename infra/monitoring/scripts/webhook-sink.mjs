// 本地演练即时应答接收器（TEX-29）：接收 Alertmanager webhook 并把告警打到 stdout。
// 只证明本地链路（Alertmanager→通知端点送达），不代替真实即时渠道/邮件兜底的送达证据。
// 安全（Greptile 审查）：仅接受 POST；请求体上限 1 MiB（超限 413）；显式请求/头超时，
// 防止无界积累内存与悬挂连接；端口在 compose 中仅绑定 127.0.0.1。
import http from "node:http";

const PORT = Number(process.env.PORT ?? 9000);
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("method not allowed\n");
    return;
  }
  const declaredLength = Number(req.headers["content-length"] ?? Number.POSITIVE_INFINITY);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    res.writeHead(413, { "content-type": "text/plain" });
    res.end("payload too large\n");
    req.resume();
    return;
  }
  let body = "";
  let size = 0;
  let oversized = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      oversized = true;
      res.writeHead(413, { "content-type": "text/plain" });
      res.end("payload too large\n");
      req.destroy();
      return;
    }
    body += chunk;
  });
  req.on("end", () => {
    if (oversized) return;
    console.log(`[webhook-sink] ${req.method} ${req.url}`);
    if (body) {
      try {
        const parsed = JSON.parse(body);
        for (const alert of parsed.alerts ?? []) {
          console.log(
            `  alert=${alert.labels?.alertname ?? "?"} severity=${alert.labels?.severity ?? "?"} ` +
              `status=${alert.status} env=${alert.labels?.environment ?? "?"} version=${alert.labels?.version ?? "?"} ` +
              `summary=${alert.annotations?.summary ?? "?"}`,
          );
        }
      } catch {
        console.log(`  raw=${body.slice(0, 400)}`);
      }
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
  });
  req.on("error", () => undefined);
  req.on("aborted", () => undefined);
});

server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

// Greptile #7：容器内须监听全部接口（Alertmanager 经 Docker bridge 访问 webhook-sink:9000，
// 只绑 127.0.0.1 会被拒连）；host 暴露仍由 compose 的 127.0.0.1:9000:9000 限制为本机。
server.listen(PORT, () => {
  console.log(`[webhook-sink] listening on :${PORT} (container-internal; host restricted by compose)`);
});
