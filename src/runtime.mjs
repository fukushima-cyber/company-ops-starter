import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { root, readJson } from "./config.mjs";

export function environment(dir, secrets, config) {
  const env = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SystemRoot", "COMSPEC", "APPDATA", "LOCALAPPDATA", "PATHEXT", "TERM"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, HERMES_HOME: path.join(dir, "hermes"), TZ: config.timezone, NOTION_TOKEN: secrets.notionToken ?? "" };
}
export function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { signal, ...spawnOptions } = options;
    if (signal?.aborted) return reject(new Error("実行を中止しました。"));
    const grouped = Boolean(signal) && process.platform !== "win32";
    const child = spawn(command, args, { stdio: "inherit", detached: grouped, ...spawnOptions });
    let timer;
    const kill = (sig) => { try { if (grouped && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch (e) { if (e.code !== "ESRCH") reject(e); } };
    const abort = () => { kill("SIGTERM"); timer = setTimeout(() => kill("SIGKILL"), 10_000); timer.unref(); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (e) => { cleanup(); reject(new Error(e.code === "ENOENT" ? `${command}がありません。READMEの前提環境を確認してください。` : e.message)); });
    child.on("close", (code) => { cleanup(); code === 0 ? resolve() : reject(new Error(`${command}が終了コード${code}で失敗しました。`)); });
  });
}
export async function configureRuntime(dir, secrets, config) {
  const home = path.join(dir, "hermes");
  await fs.mkdir(path.join(home, "home"), { recursive: true, mode: 0o700 });
  const file = path.join(home, "config.yaml");
  let current = {};
  try { current = YAML.parse(await fs.readFile(file, "utf8")) ?? {}; }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  current.terminal = { ...current.terminal, cwd: path.join(dir, "workspace"), home_mode: "profile" };
  current.mcp_servers ??= {};
  current.mcp_servers["company-notion"] = {
    command: process.execPath,
    args: [path.join(root, "node_modules/@notionhq/notion-mcp-server/bin/cli.mjs")],
    env: { NOTION_TOKEN: secrets.notionToken ?? "" },
  };
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, YAML.stringify(current), { mode: 0o600 });
  await fs.rename(temp, file);
}
export const jobDefinitions = [
  { key: "meeting", schedule: "*/5 8-20 * * *", file: "meeting.md" },
  { key: "daily", schedule: "0 9 * * *", file: "daily.md" },
  { key: "recap", schedule: "50 7 * * *", file: "recap.md" },
];
export function jobArgs(config, dir, definition) {
  return ["cron", "create", definition.schedule,
    `AGENTS.mdを読み、${definition.file}の手順を実行してください。報告は最終応答だけにし、直接送信しないでください。`,
    "--name", `ops:${config.id}:${definition.key}`, "--deliver", "local", "--workdir", path.join(dir, "workspace")];
}
export async function registerJobs(config, dir, secrets, run = execute) {
  if (!config.features.includes("meetings")) return;
  for (const definition of jobDefinitions) {
    // Read Hermes' durable list before each create; this also recovers after CLI response loss.
    const raw = await readJson(path.join(dir, "hermes/cron/jobs.json"), []);
    const jobs = Array.isArray(raw) ? raw : raw.jobs;
    if (!Array.isArray(jobs)) throw new Error("Hermesのジョブ一覧形式を確認してください。");
    const existing = jobs.filter((job) => job.name === `ops:${config.id}:${definition.key}`);
    if (existing.length > 1) throw new Error("同名ジョブが複数あります。重複を確認してください。");
    if (!existing.length) await run("hermes", jobArgs(config, dir, definition), { cwd: path.join(dir, "workspace"), env: environment(dir, secrets, config) });
  }
}
