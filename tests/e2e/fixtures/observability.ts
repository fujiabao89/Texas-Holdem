import { test as base, expect } from "@playwright/test";

/**
 * E2E 可观测性 fixture（TEX-12）：
 * 收集浏览器 console / pageerror / 网络 / WebSocket 摘要，仅在测试失败时输出。
 *
 * 脱敏约束：URL 只保留 origin + pathname（剥离 query/hash，防 token 泄露）；
 * 错误文本截断，不采集 headers、cookies 或请求/响应 body——私密牌面与密钥
 * 不会进入产物。Console error / pageerror 本身仍会随失败摘要输出（docs/06 §9：
 * 未处理错误应使测试可见）。
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

export const test = base.extend<{ diagnostics: DiagnosticsSummary }>({
  diagnostics: [
    async ({ page }, use, testInfo) => {
      const summary: DiagnosticsSummary = {
        consoleErrors: [],
        pageErrors: [],
        requests: [],
        webSockets: [],
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

      if (testInfo.status !== testInfo.expectedStatus) {
        console.error(
          `[TEX-E2E-DIAGNOSTICS] ${testInfo.titlePath.join(" > ")}\n` +
            `consoleErrors=${JSON.stringify(summary.consoleErrors)}\n` +
            `pageErrors=${JSON.stringify(summary.pageErrors)}\n` +
            `requests=${JSON.stringify(summary.requests)}\n` +
            `webSockets=${JSON.stringify(summary.webSockets)}`,
        );
      }
    },
    { auto: true },
  ],
});

export { expect };
