import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { schemaNameForRunId, writeRunIdentity } from "../e2e/real/support/run-identity";

describe("real run identity authority", () => {
  const identity = (runId: string) => ({
    runId,
    schemaName: schemaNameForRunId(runId),
    serverPort: 3261,
    webPort: 3262,
  });
  it("returns one consistent authority for the config, reloaded workers and interrupted reruns", () => {
    const directory = mkdtempSync(join(tmpdir(), "tex62-identity-"));
    const file = join(directory, "identity.json");
    try {
      const first = identity("run_a");
      expect(writeRunIdentity(first, file)).toEqual(first);
      expect(writeRunIdentity(identity("worker_b"), file)).toEqual(first);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(first);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("refuses mismatched schema authority or a concurrent run on other ports", () => {
    const directory = mkdtempSync(join(tmpdir(), "tex62-identity-"));
    const file = join(directory, "identity.json");
    try {
      writeRunIdentity(identity("run_a"), file);
      expect(() => writeRunIdentity({ ...identity("run_b"), serverPort: 3301 }, file)).toThrow(
        "different ports",
      );
      writeFileSync(file, JSON.stringify({ ...identity("run_a"), schemaName: "game" }));
      expect(() => writeRunIdentity(identity("run_b"), file)).toThrow("invalid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
