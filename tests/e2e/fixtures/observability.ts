import { test as base, expect } from "@playwright/test";

/**
 * E2E 可观测性 fixture（TEX-12）：
 * 收集浏览器 console / pageerror / 网络 / WebSocket 摘要；
 * 测试失败时输出完整摘要，测试通过时执行 docs/06 §9 门禁——
 * 未处理（未列入白名单的）console error / pageerror / HTTP 5xx 使测试失败。
 *
 * 白名单：用例内调用 `diagnostics.allow(pattern)`（substring 或 RegExp）声明
 * 预期内的诊断，例如已知第三方脚本的报错；未声明的按门禁失败。
 *
 * 脱敏约束：URL 只保留 origin + pathname（剥离 query/hash，防 token 泄露）；
 * 错误文本截断，不采集 headers、cookies 或请求/响应 body——私密牌面与密钥
 * 不会进入产物或门禁消息。
 */

const MAX_ENTRY_LENGTH = 500;

export interface RequestSummary {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

export interface WebSocketSummary {
  readonly path: string;
  readonly opened: boolean;
  closed: boolean;
}

export interface DiagnosticsSummary {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly requests: RequestSummary[];
  readonly webSockets: WebSocketSummary[];
  /** 声明门禁白名单：匹配（substring 或 RegExp）的诊断不使测试失败（docs/06 §9）。 */
  allow(pattern: string | RegExp): void;
}

function truncate(value: string): string {
  return value.length > MAX_ENTRY_LENGTH ? `${value.slice(0, MAX_ENTRY_LENGTH)}…` : value;
}

/** 剥离 query/hash，仅保留 origin + pathname。 */
function toSafePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function isAllowed(message: string, allowlist: readonly (string | RegExp)[]): boolean {
  return allowlist.some((pattern) =>
    typeof pattern === "string" ? message.includes(pattern) : pattern.test(message),
  );
}

export const test = base.extend<{ diagnostics: DiagnosticsSummary }>({
  diagnostics: [
    async ({ page }, use, testInfo) => {
      const allowlist: (string | RegExp)[] = [];
      const summary: DiagnosticsSummary = {
        consoleErrors: [],
        pageErrors: [],
        requests: [],
        webSockets: [],
        allow: (pattern) => {
          allowlist.push(pattern);
        },
      };

      page.on("console", (message) => {
        if (message.type() === "error") {
          summary.consoleErrors.push(truncate(message.text()));
        }
      });
      page.on("pageerror", (error) => {
        summary.pageErrors.push(truncate(error.message));
      });
      page.on("response", (response) => {
        summary.requests.push({
          method: response.request().method(),
          path: toSafePath(response.url()),
          status: response.status(),
        });
      });
      page.on("websocket", (websocket) => {
        const entry: WebSocketSummary = {
          path: toSafePath(websocket.url()),
          opened: true,
          closed: false,
        };
        summary.webSockets.push(entry);
        websocket.on("close", () => {
          entry.closed = true;
        });
      });

      await use(summary);

      const gateFailures = [
        ...summary.consoleErrors.map((message) => `console error: ${message}`),
        ...summary.pageErrors.map((message) => `page error: ${message}`),
        ...summary.requests
          .filter((request) => request.status >= 500)
          .map((request) => `HTTP ${request.status} ${request.method} ${request.path}`),
      ].filter((message) => !isAllowed(message, allowlist));

      if (testInfo.status === "skipped") {
        // 跳过的用例不收集到浏览器活动，也不执行门禁。
      } else if (testInfo.status !== "passed") {
        // 用例本体已失败/超时：输出完整摘要供诊断，不叠加门禁失败。
        console.error(
          `[TEX-E2E-DIAGNOSTICS] ${testInfo.titlePath.join(" > ")}\n` +
            `consoleErrors=${JSON.stringify(summary.consoleErrors)}\n` +
            `pageErrors=${JSON.stringify(summary.pageErrors)}\n` +
            `requests=${JSON.stringify(summary.requests)}\n` +
            `webSockets=${JSON.stringify(summary.webSockets)}`,
        );
      } else if (gateFailures.length > 0) {
        // 用例本体通过但存在未处理浏览器错误：按 docs/06 §9 判定失败。
        // （在 fixture teardown 抛出即失败本测试；白名单经 diagnostics.allow 声明。）
        throw new Error(
          `[TEX-E2E-GATE] ${testInfo.titlePath.join(" > ")} 存在未处理浏览器错误` +
            `（docs/06 §9；预期内错误请用 diagnostics.allow 声明白名单）：\n` +
            gateFailures.map((message) => `- ${message}`).join("\n"),
        );
      }
    },
    { auto: true },
  ],
});

export { expect };
