import { customType } from "drizzle-orm/pg-core";

/**
 * `bytea` 自定义列类型：pg 驱动往返均为 `Buffer`。
 * 用于 HMAC 摘要与 SHA-256 checksum（docs/03-data-model.md §5.2/§5.7）。
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});
