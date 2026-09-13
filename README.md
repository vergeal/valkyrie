# VALKYRIE DB

![img.png](misc/images/img_3.png)

---

## 核心特性

[点击查看版本更新日志](Documents/v1.0.0-arch.1/README.md)

### 多数据库支持

统一连接和管理多种数据库系统：

- `MySQL`
- `PostgreSQL`
- `SQLite`
- `Redis`
- `达梦数据库 (DM)`

### SQL 编辑与执行

内置数据库查询编辑器，功能包括：

- SQL 语法高亮
- 自动补全及关键字去重
- 查询执行及终止
- 提示显示表注释、字段注释
- 支持 Monaco Editor 快捷键（Ctrl+C/X/D/Shift+U 等）

![img.png](misc/images/img_4.png)

### 可视化数据管理

直观的数据浏览与编辑能力：

- 表格数据视图，支持空值/空字符串显示区分
- 表结构设计，支持字段、索引、默认值、主键、自增列
- 数据浏览与多节点层级结构展示
- 支持实时编辑与自动提交

### 数据导入与导出

- Excel 导出
- 批量导入/导出
- 数据备份与迁移

### 工作区与日志管理

- 支持标签页自由拖动及关闭联动
- 异步加载表数据和节点，避免 UI 卡顿
- 查询日志高亮显示
- 错误提示支持复制和智能解释

---

## 构建要求

- JDK 21
- OpenJFX SDK 21+
- Maven 3.9.x

---

## 打包与启动（Electron 客户端）

客户端界面在 `electron/`，启动脚本在仓库根目录，打包脚本在 `buildSrc/`。

| 平台 | 启动 | 打包安装包 |
| --- | --- | --- |
| Windows | 双击 `start.cmd` | `buildSrc\build-windows.cmd` → `electron\release\Valkyrie-0.1.0-setup.exe` |
| macOS | `./start.sh` | `./buildSrc/build-macos.sh` → `electron/release/*.dmg` / `*.zip` |

两个入口最终都执行 `start.cjs` / `buildSrc/package.cjs`（Node 写的，两份平台共用一套实现）：
启动脚本负责依赖 → 数据层 → 界面 → 拉起客户端；打包脚本负责数据层 jar → 精简 JRE（jlink）
→ 界面 → electron-builder 出安装包。jlink 产物与平台绑定，所以要在目标系统上打包。

更细的参数（`--arch`、`--dir`、`--skip-server` 等）见 `electron/README.md`。

---

## 开发规范

- 遵循 Git commit log 规范：`模块: 功能描述 / bugfix: 修复问题 / doc: 文档更新`
- 核心逻辑剥离至 `core` 模块，UI 模块负责交互
- SQL 与数据库操作全程异步，防止阻塞 UI 线程
- 自定义控件统一前缀 `Vfx*`，UI 样式统一管理

---

## 感谢图标作者

- [icons8](https://icons8.com/icons/set/warning--static--red)
- [vectors-market](https://www.flaticon.com/authors/vectors-market)
- [freepik](https://www.flaticon.com/authors/freepik)
- [pixel-perfect](https://www.flaticon.com/authors/pixel-perfect)
- [dimitry-miroliubov](https://www.flaticon.com/authors/dimitry-miroliubov)
- [gowi](https://www.flaticon.com/authors/gowi)
- [srip](https://www.flaticon.com/authors/srip)
- [hqrloveq](https://www.flaticon.com/authors/hqrloveq)
- [amazona-adorada](https://www.flaticon.com/authors/amazona-adorada)
- [fathema-khanom](https://www.flaticon.com/authors/fathema-khanom)
- [customicondesign-1](https://www.flaticon.com/authors/customicondesign-1)
- [Lee.m.yin](https://www.iconfont.cn/user/detail?spm=a313x.search_index.0.d214f71f6.590f3a81Iyg8Pg&uid=6074964&nid=qsTMfc2rGezP)
- [Adrly](https://www.flaticon.com/authors/adrly)
- [meaicon](https://www.flaticon.com/authors/meaicon)
- [刘超1](https://www.iconfont.cn/user/detail?spm=a313x.search_index.0.d214f71f6.77f83a81nUsv14&uid=8510601&nid=0ERXXv8K7oMz)
- [bddg](https://www.iconfont.cn/user/detail?spm=a313x.search_index.0.d214f71f6.77f83a811xQPvD&uid=10090073&nid=erMmXAGw4b2j)
- [guoandzhong](https://www.iconfont.cn/user/detail?spm=a313x.search_index.0.d214f71f6.77f83a814fSNRf&uid=7699424&nid=2wTyZj9eSsRT)
- [maan-icons](https://www.flaticon.com/authors/maan-icons)
