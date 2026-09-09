/**
 * TEX-40 发布/回滚脚本共享工具库（Node >= 22，ESM）。
 *
 * 只含纯函数与进程封装；不读取任何 Secret。所有函数都避免把外部数据拼进
 * shell 源码：需要子进程时一律使用 POSIX 单引号转义后交给 shell 执行，
 * 单引号转义对含空格/特殊字符的路径安全且不可注入。
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  readdir,
  readFile,
  lstat,
  realpath,
  stat,
  mkdir,
  writeFile,
  rm,
  symlink,
  readlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

/** sha256(buf) -> hex */
export function sha256OfBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** sha256(file) -> hex */
export async function sha256OfFile(filePath) {
  const data = await readFile(filePath);
  return sha256OfBuffer(data);
}

export function isInside(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r + sep);
}

/**
 * 把产物内指向本目录树内部的符号链接规范化为相对链接（POSIX）。
 *
 * 背景：pnpm 在某些环境（CI 工作目录/符号链接解析设置）会生成指向产物内部的
 * 绝对符号链接。tar 往返解压到新路径后，绝对链接仍指向原 staging 路径，导致
 * 解压后的整树摘要遍历与构建时不一致（重复计数/路径漂移）。改为相对链接后，
 * “构建 stage 摘要 == 解压后摘要”在同一根下成立，跨机可移植。
 *
 * Windows 的 junction 必须用绝对目标，本函数在 win32 下直接跳过
 * （Windows 本地不做 tar 往返移植验证，CI Linux 为权威）。
 */
export async function normalizeSymlinksRelative(root) {
  if (process.platform === "win32") return 0;
  let converted = 0;
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        const targetAbs = await realpath(full).catch(() => null);
        if (targetAbs !== null && isInside(root, targetAbs)) {
          const rel = relative(dirname(full), targetAbs).split(sep).join("/");
          const targetStat = await stat(full).catch(() => null);
          const type = targetStat?.isDirectory() ? "dir" : "file";
          await rm(full, { force: true });
          await symlink(rel, full, type);
          converted += 1;
        }
      } else if (st.isDirectory()) {
        await walk(full);
      }
    }
  }
  await walk(root);
  return converted;
}

/**
 * 稳定目录内容摘要（tar 语义、可移植）：
 *  - 普通文件：散列「相对路径 + 内容」；
 *  - 符号链接：作为叶子散列「link 相对路径 -> 目标串」（readlink 原始字符串），
 *    **不解析/不跟随**——与 tar 解压后的条目一致，结果与链接指向的机器路径无关，
 *    因此「构建 stage 摘要 == 解压后摘要」在同一根下成立；
 *  - 真实目录：递归（.pnpm 虚拟 store 为真实目录，其内容因此恰好计入一次）。
 * 真实目录与叶子条目按相对路径字典序遍历，build 与 verify 用同一函数，跨机可复现。
 */
export async function computeTreeDigest(root) {
  const hash = createHash("sha256");
  let files = 0;

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      let linkStat;
      try {
        linkStat = await lstat(full);
      } catch {
        continue; // 竞态删除/无权限：跳过，保持确定性与 build 侧一致
      }
      if (linkStat.isSymbolicLink()) {
        const target = await readlink(full).catch(() => "");
        hash.update(`link ${posixRel(root, full)}\0${target}\0`);
        files += 1;
      } else if (linkStat.isFile()) {
        hash.update(`file ${posixRel(root, full)}\0`);
        hash.update(await readFile(full));
        hash.update("\0");
        files += 1;
      } else if (linkStat.isDirectory()) {
        await walk(full);
      }
    }
  }

  await walk(root);
  return { digest: hash.digest("hex"), files };
}

function posixRel(root, full) {
  return relative(root, full).split(sep).join("/");
}

/** 对多个显式文件计算 sha256 map（相对路径 -> "sha256:<hex>"）。 */
export async function checksumsForFiles(root, relPaths) {
  const out = {};
  for (const rel of relPaths) {
    const p = join(root, rel);
    if (!existsSync(p)) {
      throw new Error(`checksumsForFiles: missing ${rel}`);
    }
    out[rel] = `sha256:${await sha256OfFile(p)}`;
  }
  return out;
}

/** 安全 POSIX 单引号转义（不可注入）。 */
export function shq(value) {
  const s = String(value);
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 返回一个可用的 POSIX shell 可执行数组前缀（win32 下发现 Git Bash）。 */
export function shellPrefix() {
  if (process.platform !== "win32") return ["/bin/sh", "-c"];
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const cand of candidates) {
    if (existsSync(cand)) return [cand, "-c"];
  }
  throw new Error(
    "build/release scripts need a POSIX shell on Windows (Git Bash). " +
      "Install Git for Windows or run inside Git Bash.",
  );
}

/**
 * 执行一段工具命令（argv 数组），用 POSIX 单引号转义拼接到 shell。
 * 返回 { code, stdout, stderr }；不抛错，由调用方判定成功并打印日志。
 */
export function runShell(argv, { cwd, env = process.env } = {}) {
  const [shell, flag] = shellPrefix();
  const command = argv.map(shq).join(" ");
  return new Promise((resolvePromise) => {
    const child = spawn(shell, [flag, command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      resolvePromise({ code: -1, stdout, stderr: `spawn error: ${err.message}` });
    });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** 把 JSON 安全写入文件（父目录自动创建）。 */
export async function writeJson(filePath, value) {
  await mkdir(dirnameSafe(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function removeTree(dir) {
  await rm(dir, { recursive: true, force: true });
}

function dirnameSafe(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? "." : p.slice(0, i);
}

/** 简单小写标识符（schema/release 目录名等）合法性校验。 */
export function assertIdentifier(value, name, pattern = /^[a-z0-9][a-z0-9._-]{0,127}$/) {
  if (!pattern.test(value)) {
    throw new Error(`${name} 不是安全标识符（期望 ${pattern.source}，得到 ${JSON.stringify(value)}）`);
  }
  return value;
}

const SENSITIVE_KEY =
  /secret|token|password|passwd|connection.?string|database_url|api[_-]?key|private[_-]?key|access[_-]?key/i;

/**
 * 审计脱敏：递归剔除疑似敏感键与明显长随机值。审计记录应尽量只写显式安全字段；
 * 此函数是纵深防御，不替代调用方选择字段。
 */
export function sanitizeForAudit(value) {
  if (Array.isArray(value)) return value.map(sanitizeForAudit);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k] = sanitizeForAudit(v);
    }
    return out;
  }
  if (typeof value === "string") {
    if (/postgres(ql)?:\/\/[^@\s]+@/.test(value)) return "<redacted:postgres-url>";
    if (/^[A-Za-z0-9+/=_-]{48,}$/.test(value) && !/^[0-9a-f]{40,}$/.test(value)) {
      return "<redacted:long-random>";
    }
    return value;
  }
  return value;
}
