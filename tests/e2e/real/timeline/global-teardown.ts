import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import teardown from "../global-teardown";
import { readRunIdentity } from "../support/run-identity";

/** Stop only this run's direct application child before removing its database schema. */
export default async function timelineTeardown() {
  const identity = readRunIdentity();
  const owned = JSON.parse(
    readFileSync(resolve(__dirname, "../../.artifacts-timeline/server-process.json"), "utf8"),
  ) as { schemaName: string; pid: number };
  if (
    owned.schemaName !== identity.schemaName ||
    !Number.isSafeInteger(owned.pid) ||
    owned.pid <= 0
  )
    throw new Error("invalid owned timeline server process");
  const exists = () => {
    try {
      process.kill(owned.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  if (exists()) {
    process.kill(owned.pid, "SIGTERM");
    const deadline = performance.now() + 5000;
    while (exists() && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    // These are disposable test processes and an isolated schema, never production.
    if (exists()) process.kill(owned.pid, "SIGKILL");
  }
  await teardown();
}
