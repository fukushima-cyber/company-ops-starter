import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { root } from "../src/config.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const exec = promisify(execFile);
test("fresh checkout offline setup works twice and generates a usable scoped configuration", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ops-cli-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const item of ["src", "templates", "company.example.json", "package.json"]) await fs.cp(path.join(root, item), path.join(dir, item), { recursive: true });
  await fs.mkdir(path.join(dir, "report")); await fs.copyFile(path.join(root, "report/llm-api.mjs"), path.join(dir, "report/llm-api.mjs"));
  await fs.copyFile(path.join(root, "report/check-log-monitor.mjs"), path.join(dir, "report/check-log-monitor.mjs"));
  await fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  const inspected = await exec(process.execPath, ["src/cli.mjs", "inspect"], { cwd: dir });
  assert.match(inspected.stdout, /読み取りのみ/);
  await exec(process.execPath, ["src/cli.mjs", "setup", "--config", "company.example.json", "--offline", "--plan"], { cwd: dir });
  await assert.rejects(fs.access(path.join(dir, "instances")), { code: "ENOENT" });
  const sample = JSON.parse(await fs.readFile(path.join(dir, "company.example.json")));
  sample.notionParent = "11111111-1111-1111-1111-111111111111";
  await fs.writeFile(path.join(dir, "online.json"), JSON.stringify(sample));
  await fs.mkdir(path.join(dir, "bin"));
  await fs.writeFile(path.join(dir, "bin/hermes"), "must not execute", { mode: 0o700 });
  await fs.writeFile(path.join(dir, "mock.mjs"), `globalThis.fetch = async (url, init) => {
    if (init.method !== "GET") throw new Error("Test blocked mutation");
    return Response.json(String(url).includes("/children") ? {results: [], has_more: false} : {});
  };`);
  const env = { ...process.env, PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`, NOTION_TOKEN: "test-secret", NODE_OPTIONS: `--import=${path.join(dir, "mock.mjs")}` };
  const planned = await exec(process.execPath, ["src/cli.mjs", "setup", "--config", "online.json", "--plan"], { cwd: dir, env });
  assert.match(planned.stdout, /新規作成/); assert.ok(!planned.stdout.includes("test-secret"));
  await assert.rejects(exec(process.execPath, ["src/cli.mjs", "setup", "--config", "online.json"], { cwd: dir, env }), /未承認/);
  await assert.rejects(fs.access(path.join(dir, "instances")), { code: "ENOENT" });
  for (let i = 0; i < 2; i++) {
    const { stdout } = await exec(process.execPath, ["src/cli.mjs", "setup", "--config", "company.example.json", "--offline"], { cwd: dir });
    assert.match(stdout, /オフライン/);
  }
  const current = JSON.parse(await fs.readFile(path.join(dir, "instances/current.json")));
  assert.equal(current.id, "example-company");
  assert.ok((await fs.readFile(path.join(dir, "instances/example-company/workspace/meeting.md"), "utf8")).includes("登録キー"));
  await assert.rejects(exec(process.execPath, ["src/cli.mjs", "doctor"], { cwd: dir }), /Notionトークンが未設定/);
});
test("pinned Notion MCP starts and exposes data-source tools without sending data", async () => {
  const client = new Client({ name: "starter-test", version: "1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "node_modules/@notionhq/notion-mcp-server/bin/cli.mjs")], env: { PATH: process.env.PATH, NOTION_TOKEN: "synthetic-no-network-token" }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name.includes("data-source")));
  } finally { await client.close(); }
});
