import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, extname, relative } from "node:path";
import { isSafeEvidence } from "../../../support/timeline-evidence";

// Independent pre-upload check also covers Playwright's own failure files.
const root = resolve(__dirname, "../../.artifacts-timeline");
let checked = 0;
let inspecting: string | null = null;
let reason = "unsafe evidence";
function problemPath(value: unknown, path = "root"): string | null {
  if (typeof value === "string")
    return /postgres(?:ql)?:\/\//i.test(value) ? `${path}: database URI` : null;
  if (value === null || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const part = /^[a-zA-Z0-9_-]{1,64}$/.test(key) ? key : "[key]";
    const next = `${path}.${part}`;
    if (
      /^(payload|playerToken|authorization|headers|cookies|deck|holeCards|privateHoleCards|burnCards|rank|suit)$/i.test(
        key,
      )
    )
      return `${next}: forbidden field`;
    const problem = problemPath(child, next);
    if (problem !== null) return problem;
  }
  return null;
}
function inspectJson(value: unknown): boolean {
  if (!isSafeEvidence(value)) {
    reason = problemPath(value) ?? "unsafe evidence";
    return false;
  }
  if (value === null || typeof value !== "object") return true;
  const record = value as Record<string, unknown>;
  if (record.name === "evidence-rejected") return false;
  if (record.name === "timeline-evidence") {
    if (typeof record.body !== "string") return false;
    try {
      if (!isSafeEvidence(JSON.parse(Buffer.from(record.body, "base64").toString("utf8"))))
        return false;
    } catch {
      return false;
    }
  }
  return Object.values(record).every(
    (item) => item === null || typeof item !== "object" || inspectJson(item),
  );
}
function scan(directory: string): void {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) {
      scan(path);
      continue;
    }
    checked++;
    inspecting = relative(root, path);
    const extension = extname(path);
    if (extension === ".png" || extension === ".webm") continue; // fixture masks all card faces
    const content = readFileSync(path, "utf8");
    let safe = false;
    if (extension === ".json") safe = inspectJson(JSON.parse(content));
    else if (extension === ".jsonl")
      safe = content
        .split("\n")
        .filter(Boolean)
        .every((line) => inspectJson(JSON.parse(line)));
    else if (extension === ".md") safe = !/Page snapshot|postgres(?:ql)?:\/\//i.test(content);
    if (!safe) throw new Error("artifact rejected before upload");
  }
}
try {
  scan(root);
  if (checked === 0) throw new Error("no artifacts to audit");
  console.log(`Timeline artifact audit passed (${checked} files)`);
} catch {
  // Only the controlled relative filename is diagnostic. Never print rejected contents.
  console.error(
    `Timeline artifact audit failed; do not upload this directory (${JSON.stringify(inspecting)?.slice(0, 256)}; ${reason.slice(0, 256)})`,
  );
  process.exitCode = 1;
}
