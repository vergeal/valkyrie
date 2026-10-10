/* Monaco 的基本语言模块没有随包提供类型声明，这里补一个最小声明 */
declare module "monaco-editor/esm/vs/basic-languages/sql/sql.js" {
  export const conf: unknown;
  export const language: unknown;
}
