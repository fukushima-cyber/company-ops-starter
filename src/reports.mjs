import path from "node:path";
import fs from "node:fs/promises";
import { root } from "./config.mjs";
import { execute, environment } from "./runtime.mjs";
export function reportEnvironment(config, dir, secrets) {
  return { ...environment(dir, secrets, config), ORG_ID: config.report.orgId, REPORT_DASHBOARD_ONLY: "1", REPORT_RETENTION_ENABLED: "0",
    DASHBOARD_URL: config.report.dashboardUrl.replace(/\/$/, ""), INGEST_API_KEY: secrets.ingestKey,
    NOTION_REPORT_DB_URL: config.databases.reports?.url,
    REPORT_LLM_PROVIDER: config.report.provider, REPORT_LLM_BASE_URL: config.report.baseUrl,
    REPORT_LLM_MODEL: config.report.model, REPORT_LLM_API_KEY: secrets.reportKey };
}
export async function runReport(config, dir, secrets, dates = [], run = execute, signal) {
  if (!config.features.includes("reports")) throw new Error("reportsが有効ではありません。");
  if (!secrets.notionToken || !secrets.ingestKey || !secrets.reportKey || !config.databases.reports?.url) throw new Error("レポートの認証・DB設定が不足しています。");
  const lock = path.join(dir, "report.lock");
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (e) { if (e.code === "EEXIST") throw new Error("レポートが実行中です。異常停止後はREADMEのロック復旧手順を確認してください。"); throw e; }
  try {
    await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
    await run("bash", [path.join(root, "report/run-daily-report.sh"), ...dates], { cwd: root, env: reportEnvironment(config, dir, secrets), signal });
  } finally { await fs.rm(lock, { recursive: true, force: true }); }
}
