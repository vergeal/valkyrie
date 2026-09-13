#!/usr/bin/env node
"use strict";

/**
 * Valkyrie 打包脚本（Windows / macOS 共用一份实现）。
 *
 *   buildSrc\build-windows.cmd          Windows 出 exe 安装包
 *   ./buildSrc/build-macos.sh           macOS 出 dmg / zip
 *   node buildSrc/package.cjs --target win|mac
 *
 * 流程：前端依赖 → 数据层 jar（mvn package）→ 精简 JRE（jlink）→ 界面（vite build）
 *      → electron-builder 出安装包到 electron/release。
 *
 * 参数：
 *   --target win|mac|current  目标平台（默认当前平台）
 *   --arch x64|arm64          目标架构（默认当前架构）
 *   --dir                     只出免安装目录，用于快速验证
 *   --skip-deps               跳过依赖检查
 *   --skip-server             跳过数据层构建
 *   --skip-runtime            复用已有的 build/runtime
 *   --jdk <path>              指定 JDK（默认取 JAVA_HOME）
 *   --help                    查看用法
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const electronDir = path.join(repoRoot, "electron");
const serverJar = path.join(repoRoot, "server", "target", "valkyrie-server.jar");
const runtimeDir = path.join(electronDir, "build", "runtime");
const releaseDir = path.join(electronDir, "release");
const isWindows = process.platform === "win32";

/* 数据层需要的 JDK 模块（jlink）：JDBC、连接池、日志、SSL、达梦驱动依赖等 */
const RUNTIME_MODULES = [
  "java.base",
  "java.sql",
  "java.naming",
  "java.desktop",
  "java.logging",
  "java.management",
  "java.security.sasl",
  "java.transaction.xa",
  "java.xml",
  "java.net.http",
  "java.scripting",
  "jdk.crypto.ec",
  "jdk.unsupported",
  "jdk.zipfs"
].join(",");

const TARGETS = { win32: "win", darwin: "mac", linux: "linux" };

/* ------------------------------ 参数 ------------------------------ */

const args = process.argv.slice(2);

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const hostTarget = TARGETS[process.platform] ?? process.platform;
const target = (valueOf("--target") ?? "current") === "current" ? hostTarget : valueOf("--target");
const arch = valueOf("--arch") ?? process.arch;
const dirOnly = args.includes("--dir");
const skipDeps = args.includes("--skip-deps");
const skipServer = args.includes("--skip-server");
const skipRuntime = args.includes("--skip-runtime");
const jdkHome = valueOf("--jdk") ?? process.env.JAVA_HOME;

const usage = `
用法：node buildSrc/package.cjs [选项]

  --target win|mac|current   目标平台（默认 current = ${hostTarget}）
  --arch x64|arm64           目标架构（默认 ${process.arch}）
  --dir                      只出免安装目录（release/win-unpacked 等）
  --skip-deps                跳过依赖检查
  --skip-server              跳过数据层构建
  --skip-runtime             复用已有的 electron/build/runtime
  --jdk <path>               指定 JDK（默认 JAVA_HOME=${process.env.JAVA_HOME ?? "未设置"}）
  --help                     显示这段帮助

Windows 上执行：buildSrc\\build-windows.cmd
macOS  上执行：./buildSrc/build-macos.sh
`;

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(usage);
  process.exit(0);
}

/* ------------------------------ 工具 ------------------------------ */

function step(message) {
  process.stdout.write(`\n[valkyrie] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`\n[valkyrie] ${message}\n`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    cwd: options.cwd || repoRoot,
    shell: isWindows,
    env: { ...process.env, ...options.env }
  });

  if (result.status !== 0)
    fail(`命令失败: ${command} ${commandArgs.join(" ")}`);
}

function emptyNpmrc() {
  const file = path.join(os.tmpdir(), "valkyrie-empty-npmrc");

  if (!fs.existsSync(file))
    fs.writeFileSync(file, "");

  return file;
}

/* ------------------------------ 步骤 ------------------------------ */

function guardTarget() {
  if (target !== hostTarget) {
    fail(
      `不能从 ${hostTarget} 上打 ${target} 的包：精简 JRE（jlink）与平台绑定，` +
        "安装包也需要对应系统的打包工具。请在目标系统上执行本脚本。"
    );
  }

  if (!["win", "mac", "linux"].includes(target))
    fail(`不支持的目标平台：${target}（支持 win / mac）`);
}

function ensureDependencies() {
  if (skipDeps) {
    step("跳过依赖检查");
    return;
  }

  if (fs.existsSync(path.join(electronDir, "node_modules", "electron"))) {
    step("依赖已就绪");
    return;
  }

  step("安装前端依赖…");

  const attempts = [
    ["install", "--no-audit", "--no-fund"],
    ["install", "--no-audit", "--no-fund", `--userconfig=${emptyNpmrc()}`]
  ];

  for (const attempt of attempts) {
    if (spawnSync("npm", attempt, { stdio: "inherit", cwd: electronDir, shell: isWindows }).status === 0)
      return;
  }

  fail("依赖安装失败，请检查网络或 npm 配置后重试");
}

function buildServer() {
  if (skipServer) {
    step("跳过数据层构建");
  } else {
    step("构建数据层（mvn package）…");
    run("mvn", ["-q", "-DskipTests", "-pl", "server", "-am", "package"]);
  }

  if (!fs.existsSync(serverJar))
    fail(`数据层产物不存在：${serverJar}`);
}

function buildRuntime() {
  if (skipRuntime && fs.existsSync(runtimeDir)) {
    step("复用已有的精简运行时");
    return;
  }

  const jlink = jdkHome
    ? path.join(jdkHome, "bin", isWindows ? "jlink.exe" : "jlink")
    : null;

  if (!jlink || !fs.existsSync(jlink)) {
    fail(
      "找不到 jlink：请设置 JAVA_HOME 指向 JDK（不是 JRE），或用 --jdk <path> 指定。\n" +
        `当前 JAVA_HOME=${process.env.JAVA_HOME ?? "未设置"}`
    );
  }

  step(`生成精简运行时（jlink，${target}/${arch}）…`);

  if (fs.existsSync(runtimeDir))
    fs.rmSync(runtimeDir, { recursive: true, force: true });

  fs.mkdirSync(path.dirname(runtimeDir), { recursive: true });

  run(jlink, [
    "--add-modules", RUNTIME_MODULES,
    "--strip-debug",
    "--no-header-files",
    "--no-man-pages",
    "--compress=zip-6",
    "--output", runtimeDir
  ]);

  const size = fs.readdirSync(runtimeDir).length
    ? `${(directorySize(runtimeDir) / 1024 / 1024).toFixed(1)} MB`
    : "0 MB";

  step(`运行时已生成：${path.relative(repoRoot, runtimeDir)}（${size}）`);
}

function directorySize(directory) {
  let total = 0;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }

  return total;
}

function buildRenderer() {
  step("构建界面…");
  run("npm", ["run", "build:renderer"], { cwd: electronDir });
}

function runBuilder() {
  step(`打包安装包（electron-builder · ${target}/${arch}${dirOnly ? " · 目录模式" : ""}）…`);

  const builderArgs = target === "win" ? ["--win"] : target === "mac" ? ["--mac"] : ["--linux"];

  if (arch)
    builderArgs.push(`--${arch}`);

  if (dirOnly)
    builderArgs.push("--dir");

  /* 直接调本地 CLI，避免 npx 再去解析包名 */
  const cli = path.join(electronDir, "node_modules", ".bin", isWindows ? "electron-builder.cmd" : "electron-builder");

  if (!fs.existsSync(cli))
    fail("未找到 electron-builder，请先安装前端依赖（npm install）");

  run(cli, builderArgs, { cwd: electronDir });
}

function report() {
  if (!fs.existsSync(releaseDir)) {
    step("打包结束（没有找到 release 目录）");
    return;
  }

  const artifacts = fs.readdirSync(releaseDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || /\.(exe|dmg|zip|AppImage|deb)$/i.test(entry.name))
    .map(entry => ({
      name: entry.name,
      time: fs.statSync(path.join(releaseDir, entry.name)).mtimeMs,
      size: entry.isDirectory() ? 0 : fs.statSync(path.join(releaseDir, entry.name)).size
    }))
    .sort((left, right) => right.time - left.time)
    .slice(0, 6);

  step("打包产物（electron/release）：");

  for (const artifact of artifacts) {
    const size = artifact.size ? `  ${(artifact.size / 1024 / 1024).toFixed(1)} MB` : "";
    process.stdout.write(`  · ${artifact.name}${size}\n`);
  }
}

/* ------------------------------ 入口 ------------------------------ */

step(`目标：${target}/${arch}（宿主：${hostTarget}/${process.arch}）`);
guardTarget();
ensureDependencies();
buildServer();
buildRuntime();
buildRenderer();
runBuilder();
report();
