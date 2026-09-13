# Valkyrie Desktop（Electron + Java 数据层）

Electron 只负责界面，数据库相关能力全部保留在 Java 侧。两者以**本地子进程 + 标准输入输出管道**通信，
不监听任何端口、不依赖任何服务端部署；安装包内自带精简 JRE，客户端无需安装 Java。

```
┌─ Electron ──────────────────────────┐        ┌─ valkyrie-server.jar ─────────────┐
│ 渲染进程  React / Monaco / 结果表格 │        │  JSON-RPC（逐行 JSON）            │
│        ↕ IPC                        │        │  core / drivers / utils           │
│ 主进程    窗口 · 生命周期 · 转发     │ ⇄ stdio │  JDBC · HikariCP · JSqlParser     │
└─────────────────────────────────────┘        └───────────────────────────────────┘
                                                          ↓ JDBC
                                          MySQL / PostgreSQL / SQLite / 达梦 / Redis
```

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `src/main/main.cjs` | Electron 主进程：拉起数据层、转发 IPC、单实例锁、退出清理 |
| `src/main/splash.cjs` | 启动卡片：数据层起来之前显示进度，主窗口 ready-to-show 后关闭 |
| `src/main/java-bridge.cjs` | 数据层进程管理与 JSON-RPC 客户端 |
| `src/preload/preload.cjs` | 渲染层唯一通道（contextBridge） |
| `src/renderer/` | React + Monaco 界面 |
| `assets/db/` | 各数据库品牌 logo（连接节点、连接下拉、连接管理器用） |
| `scripts/rpc-smoke.cjs` | 无界面冒烟测试（本地 SQLite，不访问外部数据库） |
| `scripts/ui-smoke.cjs` | 界面冒烟测试：真实窗口点击连接并执行，输出截图 |

启动脚本在仓库根目录（`start.cmd` / `start.sh`），打包脚本在 `buildSrc/`，见根目录 README。

## 功能

| 区域 | 能力 |
| --- | --- |
| 对象导航 | 我的连接 → 连接 → 数据库 → 数据表 → 表 / 查询脚本；右键走系统原生菜单，支持搜索、展开状态保留、双击连库 |
| 连接管理 | 「工具 → 连接管理」集中完成新建 / 编辑 / 复制 / 删除 / 测试连接 / 打开连接，双击一行即连 |
| 连接编辑器 | 常规（连接名、类型、地址、库、账号、密码可见性）+ 高级（时区、SSL、TINYINT 映射、附加参数、自定义 JDBC URL），带字段校验与「保存并连接」 |
| 对象页（表列表） | 名称 / 行数 / 数据长度 / 引擎 / 注释 / 时间，表头排序、搜索、多选、批量删除；「新建表」按连接类型生成建表草稿到查询控制台 |
| 数据页 | 分页浏览、单元格编辑（多行值弹气泡多行编辑，日期 / 日期时间 / 时间字段弹气泡选择器，气泡带指向单元格的箭头且可自由缩放）、整行/整列/矩形框选、列宽拖动与自适应、斑马纹、全表搜索（命中黄底）、复制为 INSERT / UPDATE / JSON、导出 CSV / Excel、提交与回滚 |
| 表设计页 | 字段与索引明细 + 可就地编辑 DDL 并「执行 DDL」（执行前二次确认） |
| 查询控制台 | Monaco 编辑器、智能提示、格式化、执行计划、右键菜单与 FX 版一致；`Ctrl+R` 执行、`Ctrl+Shift+F` 格式化、`Ctrl+W` 智能扩选 |
| 脚本 | `Ctrl+S` 保存、`Ctrl+Shift+S` 另存为；「脚本」对象页列出当前连接下所有库的 .sql，支持搜索、排序、多选、重命名、删除、在文件夹中显示；未保存的标签带圆点标记，关标签 / 断开连接前会拦一道 |
| 日志 | 按语句聚合的批次视图，按「全部 / 语句 / 错误」筛选、关键字搜索、换行开关、跟随最新、单条与整批复制；语句报错只进日志页 |
| 选项 | 主题、界面字号、编辑器字号 / 换行 / 智能提示、结果表字号 / 斑马纹 / 行号、分页大小 |

## 开发

```powershell
# 仓库根目录：Windows 双击 start.cmd，或
.\start.cmd

# macOS / Linux
./start.sh
```

启动脚本（`start.cjs`）自动完成：检查/安装依赖 → 数据层缺失或源码更新时用 Maven 重建 →
构建界面 → 启动客户端窗口。改动前端界面时只需重启这一条命令；
改动 Java 侧后它会检测到源码比产物新并自动重新打包。

其它启动方式：

| 命令 | 用途 |
| --- | --- |
| `node start.cjs` | 默认：按需重建后启动 |
| `node start.cjs --force-server` | 强制重建数据层后启动 |
| `node start.cjs --skip-server` | 跳过数据层检查，只重建界面并启动（最快） |
| `npm start`（在 `electron/` 下） | 等价于 `node ../start.cjs`，给 IDE / npm 习惯用 |
| `npm run smoke` | 无界面自检数据层链路 |
| `buildSrc\build-windows.cmd` / `./buildSrc/build-macos.sh` | 打安装包 |

启动时会先弹一张小的启动卡片（DBeaver 那种），依次显示`正在启动数据层…`、`正在加载界面…`，
主窗口就绪后自动关闭（最短显示 700ms，避免一闪而过）。自动化脚本可设 `VALKYRIE_NO_SPLASH=1` 跳过。

自检：

```powershell
npm run smoke        # 数据层链路：连接 → DDL → 查询 → 对象树
```

界面自检需要先存在一个名为「本地测试库」的 SQLite 连接：

```powershell
npx electron scripts/ui-smoke.cjs
```

编辑器自检（补全弹窗出现与行内对齐、片段展开、字段/表名候选、Ctrl+R 执行、
查询报错只出现在工作区顶部、浅色/深色弹窗配色）：

```powershell
npx electron scripts/suggest-probe.cjs
```

补全弹窗出现「文字被裁 / 行内错位」时，用几何诊断脚本定位污染弹窗样式的那组 CSS 规则
（正常时标签相对行盒的偏移为 0~3px）：

```powershell
$env:VALKYRIE_CANDIDATE="containers"; npx electron scripts/dom-probe.cjs
```

## 打包

```powershell
# Windows：产出 electron\release\Valkyrie-0.1.0-setup.exe
buildSrc\build-windows.cmd

# macOS：产出 electron/release/Valkyrie-0.1.0-x64.dmg 与 .zip
./buildSrc/build-macos.sh
```

打包脚本是 `buildSrc/package.cjs`（两个平台共用一份实现），流程：
前端依赖 → 数据层 jar（`mvn package`）→ 精简 JRE（`jlink`，约 47MB）→ 界面（`vite build`）
→ electron-builder。常用参数：`--dir` 只出免安装目录用于快速验证、`--arch arm64`、
`--skip-server` / `--skip-runtime` 复用已有产物、`--jdk <path>` 指定 JDK。

注意：jlink 产物与平台绑定，**要在目标系统上打包**（Windows 出 exe、macOS 出 dmg），
跨平台调用会被脚本直接拦下并提示。打包需要 JDK（带 jlink）与 Maven。

`electron-builder.yml` 会把三部分打进同一个安装包：

```
Valkyrie/
├── Valkyrie.exe
├── resources/app.asar          # 主进程 + 预加载 + 渲染产物
├── resources/runtime/          # 精简 JRE（jlink）
└── resources/server/valkyrie-server.jar
```

启动流程：主进程先 spawn `runtime/bin/javaw.exe -jar server/valkyrie-server.jar`，
收到 `server.ready` 后再创建窗口；关闭窗口时主进程关闭管道，数据层读到 EOF 自行退出，
不会留下僵尸进程。

## 通信协议

标准输入输出按行分隔的 JSON，标准输出只用于协议，数据层日志走标准错误。

```jsonc
// 请求
{"id": 1, "method": "query.execute", "params": {"sessionId": "s1", "sql": "select 1"}}
// 响应
{"id": 1, "result": {"jobId": 1757, "hasResultSet": true, "columns": [], "rows": []}}
// 通知（无 id）
{"method": "event", "params": {"channel": "query.progress", "kind": "cost", "detail": "12"}}
```

| 方法 | 说明 |
| --- | --- |
| `ping` | 连通性检查 |
| `connections.list` / `connections.save` / `connections.delete` | 连接配置增删查（密码沿用现有 AES-GCM 加密落盘） |
| `connection.open` / `connection.close` | 打开/关闭连接，返回会话号与根节点 |
| `schema.children` | 按节点 id 懒加载子节点（库 → 表容器 → 表） |
| `table.page` / `table.columns` / `table.indexes` / `table.ddl` | 表数据分页与结构、索引、建表语句 |
| `result.update` / `result.insert` / `result.delete` / `result.setNull` | 结果集编辑（写入待提交缓冲） |
| `result.commit` / `result.rollback` / `result.reload` / `result.export` | 提交 / 回滚 / 重新读取 / 导出 CSV、Excel |
| `queryFiles.list` / `queryFiles.read` / `queryFiles.save` / `queryFiles.rename` / `queryFiles.delete` | 本地脚本文件读写（`list` 不带 catalog 时列出该连接下所有库的脚本） |
| `sql.format` / `sql.suggest` | SQL 格式化与智能提示候选 |
| `query.execute` / `query.cancel` | 执行 SQL / 取消执行，执行过程通过 `query.progress` 推送 |

## 已知事项

- 渲染层当前会拿到解密后的连接密码（与 JavaFX 版本行为一致），后续建议改为渲染层不持有密码、
  由数据层在 `connection.open` 时按名称取用。
- Monaco 目前全量引入，bundle 约 4MB；后续只需 SQL 语言即可显著瘦身。
- 建表目前是「按数据库类型生成草稿 → 在查询控制台里改完再执行」，还没有列级别的表设计向导；
  查询历史、SSH 隧道、Redis 键浏览器也还没做。
- 样式里大量使用 `light-dark()` 跟随 `document.documentElement.style.colorScheme` 切换主题，
  因此 `vite.config.ts` 的 `build.target` 必须保持支持该特性的 Chromium 版本；
  一旦被降级成 `--lightningcss-*` 变量，深色主题在打包版里会完全失效。
- 本机 `npm` 全局 `.npmrc` 配了 `https-proxy`，会让 npm 11 静默退出；安装依赖时可加
  `--userconfig <空文件>` 绕过。`electron-builder` 首次打包需要下载 winCodeSign 等工具，
  网络受限时可用 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
  或预先放入 `%LOCALAPPDATA%\electron-builder\Cache`。
