import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { root } from "./config.mjs";

export async function executable(name, searchPath = process.env.PATH ?? "") {
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const file = path.resolve(directory, name);
    try { await fs.access(file, fs.constants.X_OK); if ((await fs.stat(file)).isFile()) return file; }
    catch (error) { if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error; }
  }
  return null;
}
async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
export async function inspectEnvironment(base = root, searchPath = process.env.PATH ?? "", home = os.homedir()) {
  const commands = {};
  for (const name of ["git", "bash", "curl", "hermes"]) commands[name] = await executable(name, searchPath);
  let instances = [];
  try {
    for (const entry of await fs.readdir(path.join(base, "instances"), { withFileTypes: true })) {
      if (entry.isDirectory() && await exists(path.join(base, "instances", entry.name, "company.json"))) instances.push(entry.name);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { node: process.version, platform: process.platform, commands, instances: instances.sort(),
    existingHermesProfile: await exists(path.join(home, ".hermes/config.yaml")) };
}
export function showEnvironment(info) {
  console.log(`環境確認（読み取りのみ）: ${info.platform}, Node ${info.node}`);
  for (const [name, file] of Object.entries(info.commands)) console.log(`${name}: ${file ? `既存を利用 ${file}` : "未検出（必要な機能を選択した場合だけ導入）"}`);
  console.log(`設定済み会社: ${info.instances.join(", ") || "なし"}`);
  if (info.existingHermesProfile) console.log("管理者の既存Hermes設定あり。別会社の認証やジョブを混ぜないため、自動コピー・変更はしません。");
}
export function requireEnvironment(info, config) {
  if (!["darwin", "linux"].includes(info.platform)) throw new Error("実行環境はmacOSまたはLinuxを使用してください。");
  if (Number(info.node.replace(/^v/, "").split(".")[0]) < 24) throw new Error("Node.js 24以上が必要です。");
  const needed = config.features.includes("reports") ? ["bash", "curl"] : [];
  if (config.features.includes("meetings")) needed.push("hermes");
  const missing = needed.filter((name) => !info.commands[name]);
  if (missing.length) throw new Error(`不足: ${missing.join(", ")}。READMEを参照して導入後に再実行してください。Notionは変更していません。`);
}
export async function hasConfiguredModel(dir) {
  try {
    const config = YAML.parse(await fs.readFile(path.join(dir, "hermes/config.yaml"), "utf8"));
    const model = typeof config?.model === "string" ? config.model : config?.model?.default;
    return typeof model === "string" && Boolean(model.trim());
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
