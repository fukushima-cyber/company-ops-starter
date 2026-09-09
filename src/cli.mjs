import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { root, validate, instanceDir, readJson, writeJson, notionId } from "./config.mjs";
import { provision, planProvision, children, schemas, checkDatabase, notionClient } from "./notion.mjs";
import { render } from "./render.mjs";
import { execute, environment, configureRuntime, registerJobs } from "./runtime.mjs";
import { runReport, reportEnvironment } from "./reports.mjs";
import { complete, apiSettings } from "../report/llm-api.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { withLock } from "./lock.mjs";
import { inspectEnvironment, showEnvironment, requireEnvironment, hasConfiguredModel } from "./preflight.mjs";
import { checkLogMonitor } from "../report/check-log-monitor.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  instance: { type: "string" }, config: { type: "string" }, offline: { type: "boolean" },
  plan: { type: "boolean" }, yes: { type: "boolean" },
} });
const command = positionals[0];
async function wizard() {
  let config = await readJson(path.join(root, "company.example.json"));
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  const ask = async (label, fallback = "") => (await rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
  try {
    const id = await ask("会社ID（既存の会社IDなら設定を再利用）", values.instance ?? "");
    const previous = await readJson(path.join(instanceDir(id), "company.json"), {});
    const savedSecrets = await readJson(path.join(instanceDir(id), "secrets.json"), {});
    config = { ...config, ...previous, id };
    config.databases ??= {};
    config.name = await ask("会社名", previous.name ?? "");
    config.timezone = await ask("タイムゾーン", config.timezone);
    const features = await ask("導入機能 meetings / reports / both", config.features.length === 2 ? "both" : config.features[0]);
    config.features = features === "both" ? ["meetings", "reports"] : [features];
    if (config.features.includes("meetings")) {
      config.meetings = (await ask("会議名（カンマ区切り）", config.meetings.join(","))).split(",").map((v) => v.trim());
      config.members = (await ask("担当者（カンマ区切り）", config.members.join(","))).split(",").map((v) => v.trim()).filter(Boolean);
    }
    config.notionParent = await ask("Notionの親ページURL（既存ページで可。接続への共有が必要）", config.notionParent);
    process.stdout.write("Notionトークン（既存の連携を利用可。保存済みなら空欄で維持・入力非表示）: "); muted = true;
    const notionToken = process.env.NOTION_TOKEN || (await rl.question("")).trim() || savedSecrets.notionToken;
    muted = false; process.stdout.write("\n");
    const secrets = { notionToken };
    if (!values.offline) {
      const databases = (await children(notionClient(notionToken), notionId(config.notionParent))).filter((block) => block.type === "child_database");
      console.log("親ページ内の既存DB:");
      for (const db of databases) console.log(`  ${db.child_database.title}: ${db.id}`);
      if (!databases.length) console.log("  なし");
      for (const [key, schema] of Object.entries(schemas(config))) {
        const input = await ask(`${schema.name}: 再利用するDBのURL/ID（空欄は専用名・標準名で自動照合）`, config.databases[key]?.id ?? "");
        if (input) config.databases[key] = { id: notionId(input) };
      }
    }
    if (config.features.includes("reports")) {
      config.report.dashboardUrl = await ask("稼働ログのダッシュボードURL", config.report.dashboardUrl);
      config.report.orgId = await ask("ダッシュボードの既存組織ID（新規作成は不要）", config.report.orgId);
      const oldProvider = config.report.provider;
      config.report.provider = await ask("レポートLLM openai-compatible / anthropic", config.report.provider);
      config.report.baseUrl = await ask("レポートLLMのAPIベースURL", oldProvider === config.report.provider ? config.report.baseUrl : config.report.provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");
      config.report.model = await ask("レポートLLMのモデル名", config.report.model);
      process.stdout.write("レポートLLMのAPIキー（入力非表示）: "); muted = true;
      secrets.reportKey = (await rl.question("")).trim(); muted = false; process.stdout.write("\n");
      process.stdout.write("組織の取り込みトークン（入力非表示）: "); muted = true;
      secrets.ingestKey = (await rl.question("")).trim(); muted = false; process.stdout.write("\n");
    }
    return { config: validate(config), secrets };
  } finally { muted = false; rl.close(); }
}
async function setup() {
  const info = await inspectEnvironment();
  showEnvironment(info);
  let config, secrets;
  if (values.config) {
    config = validate(await readJson(path.resolve(values.config)));
    secrets = { notionToken: process.env.NOTION_TOKEN, reportKey: process.env.REPORT_LLM_API_KEY, ingestKey: process.env.INGEST_API_KEY };
  } else ({ config, secrets } = await wizard());
  const dir = instanceDir(config.id);
  const previousSecrets = await readJson(path.join(dir, "secrets.json"), {});
  secrets = { ...previousSecrets, ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)) };
  const previous = await readJson(path.join(dir, "company.json"), {});
  if (previous.notionParent && notionId(previous.notionParent) !== notionId(config.notionParent) && Object.keys(previous.databases ?? {}).length) throw new Error("同じ会社IDで親ページを変更できません。別の会社IDを使用してください。");
  config.databases = { ...previous.databases, ...config.databases };
  const modelConfigured = await hasConfiguredModel(dir);
  let plan;
  if (!values.offline) {
    requireEnvironment(info, config);
    plan = await planProvision(config, notionClient(secrets.notionToken));
    console.log("実行予定（まだ作成していません）:");
    for (const item of plan) console.log(`  ${item.action === "reuse" ? "再利用" : "新規作成"}: ${item.schema.name}${item.database ? ` (${item.database.id})` : ""}`);
    if (config.features.includes("meetings")) console.log(`  LLM: ${modelConfigured ? "この会社の既存設定を維持" : "この会社専用の接続を設定"}`);
    if (config.features.includes("reports")) console.log("  Dashboard: 指定された既存組織を利用（組織は作成しません）");
  }
  if (values.plan) { console.log("確認のみで終了しました。設定保存・作成はしていません。"); return; }
  if (!values.offline && !values.yes) {
    if (!process.stdin.isTTY) throw new Error("未承認のため変更していません。--planで確認後、適用する場合だけ--yesを指定してください。");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { if ((await rl.question("この計画を適用しますか？ [y/N]: ")).trim().toLowerCase() !== "y") { console.log("変更せず終了しました。"); return; } }
    finally { rl.close(); }
  }
  return withLock(dir, "setup", async () => {
  if (JSON.stringify(await readJson(path.join(dir, "company.json"), {})) !== JSON.stringify(previous)) throw new Error("確認後に会社設定が変更されました。再実行してください。");
  await writeJson(path.join(dir, "secrets.json"), secrets);
  await writeJson(path.join(dir, "company.json"), config);
  if (!values.offline) {
    await provision(config, notionClient(secrets.notionToken), (c) => writeJson(path.join(dir, "company.json"), c), plan);
  }
  await render(config, dir);
  await configureRuntime(dir, secrets, config);
  await writeJson(path.join(root, "instances/current.json"), { id: config.id });
  console.log(`設定を保存しました: instances/${config.id}`);
  if (values.offline) { console.log("オフライン設定のみです。Notion作成・接続は未確認です。"); return; }
  if (config.features.includes("meetings") && !modelConfigured) {
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
async function watchMonitor(config, dir, secrets, signal) {
  if (!config.features.includes("reports") || !secrets.ingestKey) throw new Error("reportsと取り込みトークンが必要です。");
  while (!signal.aborted) {
    try { await checkLogMonitor(reportEnvironment(config, dir, secrets)); }
    catch (error) { console.error(`ログ監視に失敗（10分後に再試行）: ${error.message}`); }
    await delay(10 * 60_000, undefined, { signal });
  }
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
  else if (command === "inspect") showEnvironment(await inspectEnvironment());
  else {
    const { config, dir, secrets } = await load();
    const options = { env: environment(dir, secrets, config), cwd: path.join(dir, "workspace") };
    if (command === "doctor") await doctor(config, dir, secrets);
    else if (command === "llm") await execute("hermes", ["model"], options);
    else if (command === "jobs") { await doctor(config, dir, secrets); await withLock(dir, "jobs", () => registerJobs(config, dir, secrets)); }
    else if (command === "start" || command === "monitor") {
      if (command === "start") await doctor(config, dir, secrets);
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGTERM", stop); process.once("SIGINT", stop);
      const signal = controller.signal;
      const tasks = [];
      if (command === "monitor" || config.features.includes("reports")) tasks.push(watchMonitor(config, dir, secrets, signal));
      if (command === "start" && config.features.includes("meetings")) tasks.push(execute("hermes", ["gateway", "run"], { ...options, signal }).then(() => { throw new Error("Hermes gatewayが停止しました。"); }));
      if (command === "start" && config.features.includes("reports")) tasks.push((async () => {
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
