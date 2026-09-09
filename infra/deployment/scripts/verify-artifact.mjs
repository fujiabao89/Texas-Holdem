#!/usr/bin/env node
/**
 * TEX-40 artifact 完整性校验（解压/激活前必须通过；失败即中止，不得继续部署）。
 *
 * 校验：
 *   1. tarball SHA-256 与 manifest.artifact.tarballSha256（及可选 --expected-sha256）一致
 *   2. 解压后整棵目录内容摘要 == manifest.rootDigestSha256（确定性遍历，含 node_modules）
 *   3. manifest.checksums 中的关键文件逐一复算比对
 *
 * 模式：
 *   node verify-artifact.mjs --archive <tar.gz> --manifest <manifest.json> \
 *        [--expected-sha256 <hex>] [--unpack-to <dir>]
 *   node verify-artifact.mjs --dir <unpacked-dir> --manifest <manifest.json>
 *
 * 任一步不一致即 exit 1 并输出可操作差异。
 */

import { resolve, join } from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import {
  checksumsForFiles,
  computeTreeDigest,
  removeTree,
  runShell,
  sha256OfFile,
} from "./lib/artifact-lib.mjs";

/** Windows 下传给 tar/shell 需正斜杠形式。 */
const slash = (p) => p.replace(/\\/g, "/");

function usage() {
  return [
    "usage:",
    "  node verify-artifact.mjs --archive <tar.gz> --manifest <manifest.json> \\",
    "       [--expected-sha256 <hex>] [--unpack-to <dir>]",
    "  node verify-artifact.mjs --dir <unpacked-dir> --manifest <manifest.json>",
  ].join("\n");
}

async function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--archive") o.archive = argv[++i];
    else if (a === "--manifest") o.manifest = argv[++i];
    else if (a === "--dir") o.dir = argv[++i];
    else if (a === "--expected-sha256") o.expectedSha256 = argv[++i];
    else if (a === "--unpack-to") o.unpackTo = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`未知参数 ${a}\n${usage()}`);
  }
  if (!o.manifest) throw new Error(`缺少 --manifest\n${usage()}`);
  if (!o.dir && !o.archive) throw new Error(`需 --dir 或 --archive 之一\n${usage()}`);
  return o;
}

function fail(message) {
  throw new Error(`verify FAILED: ${message}`);
}

async function readManifest(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    fail(`无法读取 manifest ${path}（${e.message}）`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    fail(`manifest 不是合法 JSON（${e.message}）`);
  }
  if (manifest.schemaVersion !== 1) fail(`不支持的 manifest schemaVersion: ${manifest.schemaVersion}`);
  if (typeof manifest.rootDigestSha256 !== "string" || manifest.rootDigestSha256.length !== 64) {
    fail("manifest.rootDigestSha256 缺失或非法");
  }
  return manifest;
}

async function verifyDir(dir, manifest) {
  const digest = await computeTreeDigest(dir);
  if (digest.digest !== manifest.rootDigestSha256) {
    fail(`目录内容摘要不匹配：expect ${manifest.rootDigestSha256}\n实际            ${digest.digest}`);
  }
  const checksums = await checksumsForFiles(dir, Object.keys(manifest.checksums || {}));
  for (const rel of Object.keys(checksums)) {
    if (checksums[rel] !== manifest.checksums[rel]) {
      fail(`文件校验和不匹配：${rel}\n  expect ${manifest.checksums[rel]}\n  实际  ${checksums[rel]}`);
    }
  }
  return digest;
}

async function main() {
  const o = await parseArgs(process.argv.slice(2));
  const manifest = await readManifest(resolve(o.manifest));

  if (o.dir) {
    const digest = await verifyDir(resolve(o.dir), manifest);
    process.stdout.write(
      `verify PASS（--dir）：${digest.files} 个文件内容摘要与 manifest 一致；关键文件校验和一致\n`,
    );
    return;
  }

  const archivePath = resolve(o.archive);
  const actualSha = await sha256OfFile(archivePath);
  const expected = o.expectedSha256 ?? manifest.artifact?.tarballSha256;
  if (!expected) fail("manifest 无 tarballSha256 且未提供 --expected-sha256");
  if (actualSha !== expected) {
    fail(`tarball SHA-256 不匹配：expect ${expected}\n实际                  ${actualSha}`);
  }
  process.stdout.write(`verify PASS（archive sha256）：${actualSha}\n`);

  if (o.unpackTo) {
    const dest = resolve(o.unpackTo);
    await removeTree(dest);
    await mkdir(dest, { recursive: true });
    const res = await runShell(["tar", "--force-local", "-xzf", slash(archivePath), "-C", slash(dest)], {});
    if (res.code !== 0) fail(`解压失败（exit ${res.code}）：${res.stderr.slice(-2000)}`);
    const stageDir = join(dest, "stage");
    const digest = await verifyDir(stageDir, manifest);
    process.stdout.write(
      `verify PASS（unpack）：${digest.files} 个文件内容摘要与 manifest 一致\nunpacked at ${stageDir}\n`,
    );
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
