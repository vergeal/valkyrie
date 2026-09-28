import type { NodeDefinition } from "../sdk";
import manualStart from "./manual-start";
import end from "./end";
import conditional from "./if";
import foreach from "./foreach";
import delay from "./delay";
import stop from "./stop";
import assertNode from "./assert";
import setVariable from "./set-variable";
import getVariable from "./get-variable";
import compare from "./compare";
import log from "./log";
import notify from "./notify";
import openConnection from "./open-connection";
import closeConnection from "./close-connection";
import query from "./query";
import executeSql from "./execute-sql";
import openConnectionUi from "./open-connection-ui";
import openQueryTab from "./open-query-tab";
import executeScript from "./execute-script";
import activateTab from "./activate-tab";
import foreachConnection from "./foreach-connection";
import foreachDatabase from "./foreach-database";

/**
 * 内置节点清单。新增一个节点只需：写一个文件 + 在这里加一行（或用外部插件目录）。
 * 引擎、UI、注册表都不需要改。
 */
export const BUILTIN_NODES: NodeDefinition[] = [
  manualStart,
  end,
  conditional,
  foreach,
  delay,
  stop,
  assertNode,
  compare,
  setVariable,
  getVariable,
  log,
  notify,
  openConnection,
  closeConnection,
  query,
  executeSql,
  foreachConnection,
  foreachDatabase,
  openConnectionUi,
  openQueryTab,
  executeScript,
  activateTab
];

export default BUILTIN_NODES;
