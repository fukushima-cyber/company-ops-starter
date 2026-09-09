import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectEnvironment, requireEnvironment, hasConfiguredModel } from "../src/preflight.mjs";
import { configureRuntime } from "../src/runtime.mjs";
import YAML from "yaml";
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ops-preflight-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
test("environment inspection finds existing commands and company profiles without reading secrets", async (t) => {
  const dir = await temp(t), bin = path.join(dir, "bin");
  await fs.mkdir(bin); await fs.writeFile(path.join(bin, "hermes"), "must not execute", { mode: 0o700 });
  await fs.mkdir(path.join(dir, "instances/acme"), { recursive: true });
  await fs.writeFile(path.join(dir, "instances/acme/company.json"), "not even parsed");
  await fs.mkdir(path.join(dir, ".hermes")); await fs.writeFile(path.join(dir, ".hermes/config.yaml"), "private-secret");
  const info = await inspectEnvironment(dir, bin, dir);
  assert.equal(info.commands.hermes, path.join(bin, "hermes"));
  assert.equal(info.commands.curl, null); assert.deepEqual(info.instances, ["acme"]);
  assert.equal(info.existingHermesProfile, true); assert.ok(!JSON.stringify(info).includes("private-secret"));
  assert.equal(await fs.readFile(path.join(dir, ".hermes/config.yaml"), "utf8"), "private-secret");
});
test("prerequisites depend on the selected features, not on every possible tool", () => {
  const info = { node: "v24.0.0", platform: "linux", commands: { bash: "/bin/bash", curl: "/bin/curl", hermes: null } };
  assert.doesNotThrow(() => requireEnvironment(info, { features: ["reports"] }));
  assert.throws(() => requireEnvironment(info, { features: ["meetings"] }), /hermes/);
  assert.throws(() => requireEnvironment({ ...info, node: "v20.0.0" }, { features: ["reports"] }), /Node/);
});
test("existing scoped model and custom provider are retained when configuring Notion", async (t) => {
  const dir = await temp(t);
  assert.equal(await hasConfiguredModel(dir), false);
  await fs.mkdir(path.join(dir, "hermes"));
  const existing = { model: { default: "company-model", provider: "custom" }, providers: { custom: { base_url: "https://example.com/v1" } } };
  await fs.writeFile(path.join(dir, "hermes/config.yaml"), YAML.stringify(existing));
  assert.equal(await hasConfiguredModel(dir), true);
  await configureRuntime(dir, { notionToken: "test" }, {});
  const updated = YAML.parse(await fs.readFile(path.join(dir, "hermes/config.yaml"), "utf8"));
  assert.deepEqual(updated.model, existing.model); assert.deepEqual(updated.providers, existing.providers);
});
