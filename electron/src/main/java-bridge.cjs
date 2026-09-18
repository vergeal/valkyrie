"use strict";

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const fs = require("node:fs");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * 数据层进程（valkyrie-server.jar）的启动参数。
 * <p>
 * 开发态使用系统 Java 与 Maven 产物；打包后使用随安装包分发的精简运行时
 * （resources/runtime）与 resources/server/valkyrie-server.jar。
 */
function resolveJavaCommand() {
  if (process.env.VALKYRIE_JAVA)
    return process.env.VALKYRIE_JAVA;

  const resourcesPath = process.resourcesPath;

  if (resourcesPath) {
    const bundled = process.platform === "win32"
      ? path.join(resourcesPath, "runtime", "bin", "javaw.exe")
      : path.join(resourcesPath, "runtime", "bin", "java");

    if (fs.existsSync(bundled))
      return bundled;
  }

  return "java";
}

function resolveJarPath() {
  if (process.env.VALKYRIE_SERVER_JAR)
    return process.env.VALKYRIE_SERVER_JAR;

  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, "server", "valkyrie-server.jar");

    if (fs.existsSync(bundled))
      return bundled;
  }

  return path.join(REPO_ROOT, "server", "target", "valkyrie-server.jar");
}

/**
 * 与数据层通信的 JSON-RPC 客户端。
 * <p>
 * 请求与响应按行分隔写在子进程的标准输入输出上；数据层日志走标准错误，
 * 在这里转发到 Electron 主进程的控制台，不会污染协议。
 */
class JavaBridge extends EventEmitter {
  constructor(options = {}) {
    super();

    this.javaCommand = options.javaCommand || resolveJavaCommand();
    this.jarPath = options.jarPath || resolveJarPath();
    this.startupTimeout = options.startupTimeout || 30000;
    /* 额外的 JVM 参数（AppCDS / headless 等），由主进程按用户目录拼好后传入 */
    this.jvmArgs = options.jvmArgs || [];

    this.child = null;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  start() {
    if (this.starting)
      return this.starting;

    this.starting = new Promise((resolve, reject) => {
      if (!fs.existsSync(this.jarPath)) {
        reject(new Error(`数据层程序不存在: ${this.jarPath}，请先执行 npm run build:server`));
        return;
      }

      const child = spawn(this.javaCommand, [...this.jvmArgs, "-jar", this.jarPath], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });

      this.child = child;

      const timer = setTimeout(() => {
        reject(new Error("数据层启动超时"));
      }, this.startupTimeout);

      timer.unref();

      readline.createInterface({ input: child.stdout }).on("line", line => this.#handleLine(line));

      child.stderr.on("data", chunk => {
        this.emit("log", chunk.toString());
      });

      child.on("error", error => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("exit", code => {
        clearTimeout(timer);
        this.child = null;
        this.#rejectAll(new Error(`数据层进程已退出 (code=${code})`));
        this.emit("exit", code);
      });

      this.once("server.ready", params => {
        clearTimeout(timer);
        this.emit("ready", params);
        resolve(params);
      });
    });

    return this.starting;
  }

  call(method, params = {}) {
    if (!this.child || !this.child.stdin.writable)
      return Promise.reject(new Error("数据层尚未就绪"));

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async stop() {
    const child = this.child;

    if (!child)
      return;

    /* 关闭标准输入即通知数据层退出，进程会先排空正在执行的请求 */
    const exited = new Promise(resolve => child.once("exit", resolve));

    child.stdin.end();

    const killed = setTimeout(() => {
      if (this.child)
        child.kill();
    }, 5000);

    killed.unref();

    await exited;
    clearTimeout(killed);
  }

  #handleLine(line) {
    if (!line)
      return;

    let message;

    try {
      message = JSON.parse(line);
    } catch {
      this.emit("log", `无法解析的数据层消息: ${line}\n`);
      return;
    }

    if (message.method === "event") {
      const params = message.params || {};

      this.emit(params.channel, params);
      this.emit("event", params);
      return;
    }

    const entry = this.pending.get(message.id);

    if (!entry)
      return;

    this.pending.delete(message.id);

    if (message.error)
      entry.reject(new Error(message.error.message || "数据层调用失败"));
    else
      entry.resolve(message.result);
  }

  #rejectAll(error) {
    for (const entry of this.pending.values())
      entry.reject(error);

    this.pending.clear();
  }
}

module.exports = { JavaBridge, resolveJavaCommand, resolveJarPath, REPO_ROOT };
