import type { NodeDefinition } from "../sdk";
import manualStart from "./manual-start";
import end from "./end";
import openConnection from "./open-connection";
import openDatabase from "./open-database";
import openSchema from "./open-schema";
import openScript from "./open-script";
import executeSql from "./execute-sql";

/**
 * 内置节点清单。新增一个节点只需：写一个文件 + 在这里加一行（或用外部插件目录）。
 * 引擎、UI、注册表都不需要改。
 *
 * 当前处于自动化重构阶段：逐步把重新设计好的节点加回来。
 */
export const BUILTIN_NODES: NodeDefinition[] = [
  manualStart,
  end,
  openConnection,
  openDatabase,
  openSchema,
  openScript,
  executeSql
];

export default BUILTIN_NODES;
