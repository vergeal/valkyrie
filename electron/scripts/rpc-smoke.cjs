"use strict";

/**
 * 无界面冒烟测试：验证 Electron 主进程与 Java 数据层的完整链路。
 * 使用本地 SQLite 临时库，不触碰任何外部数据库。
 *
 *   node scripts/rpc-smoke.cjs
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { JavaBridge } = require("../src/main/java-bridge.cjs");

async function main() {
  const dbPath = path.join(os.tmpdir(), `valkyrie-smoke-${Date.now()}.db`);
  const bridge = new JavaBridge();

  bridge.on("log", chunk => process.stderr.write(`[java] ${chunk}`));
  bridge.on("query.progress", event => process.stderr.write(`[progress] ${event.kind}: ${event.detail}\n`));

  console.log("ready:", JSON.stringify(await bridge.start()));
  console.log("ping:", JSON.stringify(await bridge.call("ping")));

  const saved = await bridge.call("connections.list");
  console.log("已保存连接:", saved.connections.map(item => item.name).join(" | ") || "(无)");

  const opened = await bridge.call("connection.open", {
    connection: {
      name: "本地冒烟测试",
      type: "sqlite",
      jdbcUrl: `jdbc:sqlite:${dbPath}`,
      username: "",
      password: ""
    }
  });

  console.log("session:", opened.sessionId, "product:", JSON.stringify(opened.product));
  console.log("根节点:", opened.nodes.map(node => `${node.label}(${node.kind})`).join(", ") || "(无)");

  await bridge.call("query.execute", {
    sessionId: opened.sessionId,
    sql: [
      "CREATE TABLE demo_order (id INTEGER PRIMARY KEY, title TEXT, amount REAL);",
      "INSERT INTO demo_order (id, title, amount) VALUES (1, '测试订单', 88.5), (2, '第二条', 12.0);"
    ].join("\n")
  });

  const result = await bridge.call("query.execute", {
    sessionId: opened.sessionId,
    sql: "SELECT id, title, amount FROM demo_order ORDER BY id"
  });

  console.log("列:", result.columns.map(column => `${column.label}:${column.type}${column.primary ? "*" : ""}`).join(", "));
  console.log("数据:", JSON.stringify(result.rows));

  /* 智能提示：光标在 WHERE 之后，应给出该表的字段 */
  const suggestion = await bridge.call("sql.suggest", {
    sessionId: opened.sessionId,
    catalog: "Master",
    sql: "SELECT id, title FROM demo_order WHERE ",
    offset: "SELECT id, title FROM demo_order WHERE ".length
  });

  console.log("智能提示:", suggestion.suggestions.slice(0, 8).map(item => `${item.label}(${item.kind})`).join(", "));

  /* 结果集编辑：改单元格 → 提交 → 新增行 → 删除行 */
  const editable = await bridge.call("query.execute", {
    sessionId: opened.sessionId,
    sql: "SELECT id, title, amount FROM demo_order ORDER BY id"
  });

  console.log("可编辑:", editable.editable, "可新增:", editable.addable, "jobId:", editable.jobId);

  const updated = await bridge.call("result.update", {
    jobId: editable.jobId,
    row: 0,
    col: 1,
    value: "改过的标题"
  });

  console.log("修改缓冲 dirty:", updated.dirty, "→", JSON.stringify(updated.changed));

  /* 分页：只取第 0 行，确认 rowCount / truncated 正确 */
  const pages = await bridge.call("result.page", { jobId: editable.jobId, offset: 0, size: 1 });
  console.log("分页 offset=0 size=1:", JSON.stringify(pages.rows), "rowCount:", pages.rowCount, "truncated:", pages.truncated);

  const committed = await bridge.call("result.commit", { jobId: editable.jobId });
  console.log("提交后:", JSON.stringify(committed.rows));

  const inserted = await bridge.call("result.insert", { jobId: editable.jobId });
  console.log("新增空行后行数:", inserted.rowCount, "变化:", JSON.stringify(inserted.changed));

  const deleted = await bridge.call("result.delete", { jobId: editable.jobId, rows: [0] });
  console.log("删除首行后 deletedRows:", JSON.stringify(deleted.deletedRows), "变化:", JSON.stringify(deleted.changed));

  /* 导出 CSV / Excel */
  const csvPath = path.join(os.tmpdir(), "valkyrie-export-smoke.csv");
  const xlsxPath = path.join(os.tmpdir(), "valkyrie-export-smoke.xlsx");

  const csv = await bridge.call("result.export", { jobId: editable.jobId, format: "csv", path: csvPath });
  const xlsx = await bridge.call("result.export", { jobId: editable.jobId, format: "excel", path: xlsxPath });

  console.log("导出 CSV:", csv.rows, "行 →", fs.statSync(csvPath).size, "字节");
  console.log("导出 Excel:", xlsx.rows, "行 →", fs.statSync(xlsxPath).size, "字节");

  if (opened.nodes.length) {
    const children = await bridge.call("schema.children", {
      sessionId: opened.sessionId,
      nodeId: opened.nodes[0].id
    });

    console.log("子节点:", children.nodes.map(node => `${node.label}(${node.kind})`).join(", ") || "(无)");

    const container = children.nodes.find(node => node.hasChildren);

    if (container) {
      const tables = await bridge.call("schema.children", {
        sessionId: opened.sessionId,
        nodeId: container.id
      });

      console.log("数据表:", tables.nodes.map(node => node.label).join(", ") || "(无)");
    }
  }

  await bridge.call("connection.close", { sessionId: opened.sessionId });
  await bridge.stop();

  fs.rmSync(dbPath, { force: true });
  fs.rmSync(csvPath, { force: true });
  fs.rmSync(xlsxPath, { force: true });
  console.log("OK");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
