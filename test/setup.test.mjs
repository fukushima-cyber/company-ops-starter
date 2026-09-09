import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { validate, instanceDir, notionId, writeJson } from "../src/config.mjs";
import { schemas, provision, checkDatabase, children, notionClient } from "../src/notion.mjs";
import { environment, configureRuntime, registerJobs } from "../src/runtime.mjs";
import { render } from "../src/render.mjs";
import { runReport, reportEnvironment } from "../src/reports.mjs";
import { withLock } from "../src/lock.mjs";
const parent = "11111111-1111-1111-1111-111111111111";
const config = (id = "example-company") => ({ id, name: id, timezone: "Asia/Tokyo", features: ["meetings"], meetings: ["週次定例"], members: ["担当者A"], cleanupDays: 0, notionParent: parent, databases: {} });
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ops-setup-test-")); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
function fakeNotion() {
  const dbs = new Map(); let count = 0, fail = false;
  return { dbs, get count() { return count; }, failNext() { fail = true; }, api: async (url, method, body) => {
    if (url.startsWith("/pages/")) return { id: parent };
    if (url.startsWith("/blocks/")) return { results: [...dbs.values()].map((db) => ({ id: db.id, type: "child_database", child_database: { title: db.title } })), has_more: false };
    if (url === "/databases" && method === "POST") {
      const id = `00000000-0000-0000-0000-${String(++count).padStart(12, "0")}`;
      const properties = Object.fromEntries(Object.entries(body.initial_data_source.properties).map(([key, value]) => [key, { type: Object.keys(value)[0], ...value }]));
      dbs.set(id, { id, parent: body.parent, title: body.title[0].text.content, data_sources: [{ id }], properties });
      if (fail) { fail = false; throw new Error("response lost after create"); }
      return { id };
    }
    const id = url.split("/").at(-1); const db = dbs.get(id);
    if (!db) throw new Error(`Not found ${url}`);
    return db;
  } };
}
test("configuration rejects traversal, invalid timezone and unsupported report endpoints", () => {
  assert.equal(validate(config()).id, "example-company");
  for (const patch of [{ id: "../oops" }, { timezone: undefined }, { timezone: "invalid" }, { cleanupDays: -1 }, { meetings: [] }]) assert.throws(() => validate({ ...config(), ...patch }));
  assert.throws(() => instanceDir("../../oops"));
  assert.equal(notionId(`https://notion.so/Page-${parent.replaceAll("-", "")}?v=ignored`), parent);
  assert.throws(() => validate({ ...config(), features: ["reports"] }));
});
test("Notion provisioning creates three databases and reruns without duplication", async () => {
  const c = config(), fake = fakeNotion(); let checkpoints = 0;
  await provision(c, fake.api, async () => checkpoints++);
  assert.equal(fake.count, 3); assert.equal(checkpoints, 6);
  await provision(c, fake.api, async () => {}); assert.equal(fake.count, 3);
  assert.ok(c.databases.tasks.dataSourceId);
});
test("Notion response-loss recovery rediscovers the created database", async () => {
  const c = config(), fake = fakeNotion(); fake.failNext();
  await assert.rejects(provision(c, fake.api, async () => {}), /response lost/);
  assert.deepEqual(c.databases, {});
  await provision(c, fake.api, async () => {}); assert.equal(fake.count, 3);
});
test("both features provision four databases, while reports-only provisions one", async () => {
  for (const [features, expected] of [[["meetings", "reports"], 4], [["reports"], 1]]) {
    const c = { ...config(), features }, fake = fakeNotion();
    await provision(c, fake.api, async () => {}); assert.equal(fake.count, expected);
    assert.ok(c.databases.reports.dataSourceId);
  }
});
test("ambiguous duplicate Notion database names stop before creating or modifying data", async () => {
  const c = config(), fake = fakeNotion(); await provision(c, fake.api, async () => {});
  const first = [...fake.dbs.values()][0]; fake.dbs.set("duplicate", { ...first, id: "duplicate" });
  c.databases = {};
  await assert.rejects(provision(c, fake.api, async () => {}), /同名DB/);
  assert.equal(fake.count, 3);
});
test("Notion schema mismatch and foreign-company parent fail closed", async () => {
  const c = config(), fake = fakeNotion(); await provision(c, fake.api, async () => {});
  const schema = schemas(c).tasks, db = fake.dbs.get(c.databases.tasks.id);
  await assert.rejects(checkDatabase(fake.api, db.id, schema, "22222222-2222-2222-2222-222222222222"), /親ページ/);
  db.properties.承認.type = "rich_text";
  await assert.rejects(checkDatabase(fake.api, db.id, schema), /承認/);
});
test("Notion pagination and redacted auth errors", async () => {
  let calls = 0;
  const rows = await children(async (url) => ++calls === 1 ? { results: [1], has_more: true, next_cursor: "next" } : (assert.match(url, /start_cursor=next/), { results: [2], has_more: false }), parent);
  assert.deepEqual(rows, [1, 2]);
  await assert.rejects(children(async () => ({ results: [], has_more: true }), parent), /不完全/);
  await assert.rejects(notionClient("fake-secret", async () => new Response("fake-secret", { status: 401 }))("/users/me"), (e) => !e.message.includes("fake-secret"));
});
test("two companies render isolated workspaces, credentials and runtime profiles", async (t) => {
  const dir = await temp(t);
  for (const id of ["alpha", "beta"]) {
    const c = config(id), target = path.join(dir, id); c.members = [id];
    await writeJson(path.join(target, "secrets.json"), { notionToken: `${id}-secret` });
    await render(c, target); await configureRuntime(target, { notionToken: `${id}-secret` }, c);
    const content = await fs.readFile(path.join(target, "workspace/AGENTS.md"), "utf8");
    assert.match(content, new RegExp(id)); assert.ok(!content.includes(id === "alpha" ? "beta" : "alpha")); assert.ok(!content.includes("-secret"));
    const runtime = YAML.parse(await fs.readFile(path.join(target, "hermes/config.yaml"), "utf8"));
    assert.equal(runtime.mcp_servers["company-notion"].env.NOTION_TOKEN, `${id}-secret`);
    assert.equal((await fs.stat(path.join(target, "secrets.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(target, "hermes/config.yaml"))).mode & 0o777, 0o600);
  }
  process.env.ANTHROPIC_API_KEY = "foreign-secret";
  try { assert.equal(environment(dir, {}, config()).ANTHROPIC_API_KEY, undefined); } finally { delete process.env.ANTHROPIC_API_KEY; }
});
test("cron registration is resumable and never creates duplicate jobs", async (t) => {
  const dir = await temp(t), c = config(); let calls = 0; const jobs = [];
  const run = async (cmd, args, options) => {
    assert.equal(cmd, "hermes"); assert.ok(args.includes("local")); assert.equal(options.env.HERMES_HOME, path.join(dir, "hermes"));
    assert.equal(args.at(-1), path.join(dir, "workspace"));
    jobs.push({ name: args[args.indexOf("--name") + 1] }); calls++;
    await writeJson(path.join(dir, "hermes/cron/jobs.json"), { jobs });
  };
  await registerJobs(c, dir, {}, run); await registerJobs(c, dir, {}, run); assert.equal(calls, 3);
});
test("per-company locks prevent concurrent setup and release after failure", async (t) => {
  const dir = await temp(t);
  await assert.rejects(withLock(dir, "setup", async () => {
    await assert.rejects(withLock(dir, "setup", async () => {}), /実行中/); throw new Error("simulated");
  }), /simulated/);
  await withLock(dir, "setup", async () => {});
});
test("report execution isolates keys, disables shared-drive fallback, locks and recovers", async (t) => {
  const dir = await temp(t), c = { ...config(), features: ["reports"], report: { orgId: "org-test", provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "test", dashboardUrl: "https://example.com/" }, databases: { reports: { url: "https://notion.so/test" } } };
  const secrets = { notionToken: "notion-test", reportKey: "llm-test", ingestKey: "ingest-test" };
  assert.equal(reportEnvironment(c, dir, secrets).REPORT_DASHBOARD_ONLY, "1");
  await assert.rejects(runReport(c, dir, secrets, [], async (_cmd, _args, options) => {
    assert.equal(options.env.REPORT_LLM_API_KEY, "llm-test");
    await assert.rejects(runReport(c, dir, secrets, [], async () => {}), /実行中/); throw new Error("simulated");
  }), /simulated/);
  await runReport(c, dir, secrets, [], async () => {});
});
