// 本地演练即时应答接收器（TEX-29）：接收 Alertmanager webhook 并把告警打到 stdout。
// 只证明本地链路（Alertmanager→通知端点送达），不代替真实即时渠道/邮件兜底的送达证据。
import http from "node:http";

const PORT = Number(process.env.PORT ?? 9000);

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
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
});

server.listen(PORT, () => {
  console.log(`[webhook-sink] listening on :${PORT}`);
});
