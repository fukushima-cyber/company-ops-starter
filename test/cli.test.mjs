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
  await fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
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
