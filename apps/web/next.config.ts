import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 开发服务器按 host 校验 /_next/* 资源与 HMR 的来源；E2E 使用
  // http://127.0.0.1:3100 访问，未显式允许时该来源的静态块与 HMR
  // WebSocket 会被 403 拒绝（tests/e2e 的 docs/06 §9 门禁会因此失败）。
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
