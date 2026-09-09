import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { root, validate, instanceDir, readJson, writeJson } from "./config.mjs";
import { provision, schemas, checkDatabase, notionClient } from "./notion.mjs";
import { render } from "./render.mjs";
import { execute, environment, configureRuntime, registerJobs } from "./runtime.mjs";
import { runReport, reportEnvironment } from "./reports.mjs";
import { complete, apiSettings } from "../report/llm-api.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { withLock } from "./lock.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  instance: { type: "string" }, config: { type: "string" }, offline: { type: "boolean" },
} });
const command = positionals[0];
async function wizard() {
  const config = await readJson(path.join(root, "company.example.json"));
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  const ask = async (label, fallback = "") => (await rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
  try {
    config.id = await ask("会社ID（英小文字・数字・ハイフン）");
    config.name = await ask("会社名");
    config.timezone = await ask("タイムゾーン", "Asia/Tokyo");
    const features = await ask("導入機能 meetings / reports / both", "meetings");
    config.features = features === "both" ? ["meetings", "reports"] : [features];
    if (config.features.includes("meetings")) {
      config.meetings = (await ask("会議名（カンマ区切り）", "週次定例")).split(",").map((v) => v.trim());
      config.members = (await ask("担当者（カンマ区切り。空欄可）")).split(",").map((v) => v.trim()).filter(Boolean);
    }
    config.notionParent = await ask("Notionの親ページURL（先に連携へ共有してください）");
    process.stdout.write("Notionトークン（入力は表示しません）: "); muted = true;
    const notionToken = process.env.NOTION_TOKEN || (await rl.question("")).trim();
    muted = false; process.stdout.write("\n");
    const secrets = { notionToken };
    if (config.features.includes("reports")) {
      config.report.dashboardUrl = await ask("稼働ログのダッシュボードURL", config.report.dashboardUrl);
      config.report.orgId = await ask("ダッシュボードの組織ID");
      config.report.provider = await ask("レポートLLM openai-compatible / anthropic", "openai-compatible");
      config.report.baseUrl = await ask("レポートLLMのAPIベースURL", config.report.provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");
      config.report.model = await ask("レポートLLMのモデル名");
      process.stdout.write("レポートLLMのAPIキー（入力非表示）: "); muted = true;
      secrets.reportKey = (await rl.question("")).trim(); muted = false; process.stdout.write("\n");
      process.stdout.write("組織の取り込みトークン（入力非表示）: "); muted = true;
      secrets.ingestKey = (await rl.question("")).trim(); muted = false; process.stdout.write("\n");
    }
    return { config: validate(config), secrets };
  } finally { muted = false; rl.close(); }
}
async function setup() {
  let config, secrets;
  if (values.config) {
    config = validate(await readJson(path.resolve(values.config)));
    secrets = { notionToken: process.env.NOTION_TOKEN, reportKey: process.env.REPORT_LLM_API_KEY, ingestKey: process.env.INGEST_API_KEY };
  } else ({ config, secrets } = await wizard());
  const dir = instanceDir(config.id);
  return withLock(dir, "setup", async () => {
  const previousSecrets = await readJson(path.join(dir, "secrets.json"), {});
  secrets = { ...previousSecrets, ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)) };
  const previous = await readJson(path.join(dir, "company.json"), {});
  if (previous.notionParent && previous.notionParent !== config.notionParent && Object.keys(previous.databases ?? {}).length) throw new Error("同じ会社IDで親ページを変更できません。別の会社IDを使用してください。");
  config.databases = { ...previous.databases, ...config.databases };
  await writeJson(path.join(dir, "secrets.json"), secrets);
  await writeJson(path.join(dir, "company.json"), config);
  if (!values.offline) {
    await provision(config, notionClient(secrets.notionToken), (c) => writeJson(path.join(dir, "company.json"), c));
  }
  await render(config, dir);
  await configureRuntime(dir, secrets, config);
  await writeJson(path.join(root, "instances/current.json"), { id: config.id });
  console.log(`設定を保存しました: instances/${config.id}`);
  if (values.offline) { console.log("オフライン設定のみです。Notion作成・接続は未確認です。"); return; }
  if (config.features.includes("meetings")) {
    console.log("この会社専用のLLMを選択します。認証もHermesの案内で設定できます。");
    await execute("hermes", ["model"], { cwd: path.join(dir, "workspace"), env: environment(dir, secrets, config) });
  }
  console.log("次: npm run doctor → npm run jobs → npm start。配信先は初期状態ではlocalです。");
  });
}
async function load() {
  const id = values.instance ?? (await readJson(path.join(root, "instances/current.json"))).id;
  const dir = instanceDir(id);
  return { dir, config: validate(await readJson(path.join(dir, "company.json"))), secrets: await readJson(path.join(dir, "secrets.json")) };
}
async function doctor(config, dir, secrets) {
  const api = notionClient(secrets.notionToken);
  await api("/users/me");
  for (const [key, schema] of Object.entries(schemas(config))) {
    if (!config.databases[key]?.id) throw new Error(`${schema.name}が未作成です。setupをオンラインで実行してください。`);
    await checkDatabase(api, config.databases[key].id, schema, config.notionParent);
    console.log(`OK Notion: ${schema.name}`);
  }
  if (config.features.includes("meetings")) {
    await execute("hermes", ["--version"], { env: environment(dir, secrets, config) });
    await execute("hermes", ["mcp", "test", "company-notion"], { env: environment(dir, secrets, config), cwd: path.join(dir, "workspace") });
  }
  if (config.features.includes("reports")) {
    if (!secrets.reportKey || !secrets.ingestKey || !config.report.model || !config.report.orgId) throw new Error("レポートのLLM・組織設定が不足しています。");
    const response = await fetch(`${config.report.dashboardUrl.replace(/\/$/, "")}/api/logs?date=2000-01-01`, { redirect: "error", headers: { Authorization: `Bearer ${secrets.ingestKey}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`ダッシュボード認証失敗: ${response.status}`);
    console.log("OK Dashboard authentication");
  }
  console.log("接続とDB形式を確認しました。実データを作る受入テストはREADMEを参照してください。");
}
try {
  if (command === "setup") await setup();
  else {
    const { config, dir, secrets } = await load();
    const options = { env: environment(dir, secrets, config), cwd: path.join(dir, "workspace") };
    if (command === "doctor") await doctor(config, dir, secrets);
    else if (command === "llm") await execute("hermes", ["model"], options);
    else if (command === "jobs") { await doctor(config, dir, secrets); await withLock(dir, "jobs", () => registerJobs(config, dir, secrets)); }
    else if (command === "start") {
      await doctor(config, dir, secrets);
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGTERM", stop); process.once("SIGINT", stop);
      const signal = controller.signal;
      const tasks = [];
      if (config.features.includes("meetings")) tasks.push(execute("hermes", ["gateway", "run"], { ...options, signal }).then(() => { throw new Error("Hermes gatewayが停止しました。"); }));
      if (config.features.includes("reports")) tasks.push((async () => {
        while (!signal.aborted) {
          try { await runReport(config, dir, secrets, [], execute, signal); }
          catch (error) { console.error(`レポート失敗（30分後に再試行）: ${error.message}`); }
          await delay(30 * 60_000, undefined, { signal });
        }
      })());
      try { await Promise.race(tasks); }
      finally { controller.abort(); await Promise.allSettled(tasks); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
    } else if (command === "verify-llm") {
      // Preserve the selected provider config, but disable plugins/MCP and rule injection.
      if (config.features.includes("meetings")) await execute("hermes", ["chat", "--ignore-rules", "--toolsets", "verification-no-tools", "--max-turns", "1", "--run-budget", "60", "--oneshot", "-Q", "-q", "Reply exactly OK."], { ...options, env: { ...options.env, HERMES_SAFE_MODE: "1" } });
      if (config.features.includes("reports")) {
        await complete("Reply exactly OK.", apiSettings(reportEnvironment(config, dir, secrets)));
        console.log("OK Report LLM returned text");
      }
    } else if (command === "report") await runReport(config, dir, secrets, positionals.slice(1));
    else throw new Error("setup / doctor / llm / jobs / start / report / verify-llm を指定してください。");
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
