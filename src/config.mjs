import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const root = fileURLToPath(new URL("../", import.meta.url));
export function validate(config) {
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(config.id ?? "")) throw new Error("会社IDは英小文字・数字・ハイフンで2〜49文字にしてください。");
  if (typeof config.name !== "string" || !config.name.trim()) throw new Error("会社名が必要です。");
  if (typeof config.timezone !== "string" || !config.timezone) throw new Error("タイムゾーンが必要です。");
  new Intl.DateTimeFormat("en", { timeZone: config.timezone }).format();
  if (!Array.isArray(config.features) || !config.features.length || config.features.some((f) => !["meetings", "reports"].includes(f))) throw new Error("featuresはmeetings/reportsから選択してください。");
  for (const key of ["meetings", "members"]) {
    if (!Array.isArray(config[key]) || config[key].some((v) => typeof v !== "string" || !v.trim())) throw new Error(`${key}は文字列の配列にしてください。`);
  }
  if (config.features.includes("meetings") && !config.meetings.length) throw new Error("会議シリーズを1つ以上設定してください。");
  if (!Number.isInteger(config.cleanupDays) || config.cleanupDays < 0) throw new Error("cleanupDaysは0以上の整数です。0で自動削除を無効にします。");
  if (config.features.includes("reports")) {
    if (!config.report?.orgId || !config.report.model) throw new Error("レポートの組織IDとモデル名が必要です。");
    if (!["openai-compatible", "anthropic"].includes(config.report.provider)) throw new Error("レポートLLMのproviderを確認してください。");
    for (const value of [config.report.baseUrl, config.report.dashboardUrl]) validateUrl(value);
    if (config.timezone !== "Asia/Tokyo") throw new Error("稼働レポートの日次集計は現在Asia/Tokyoのみ対応しています。");
  }
  return config;
}
export function validateUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("接続先はHTTPS、ローカル接続のみHTTPを指定してください。");
  return url;
}
export function instanceDir(id) {
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(id ?? "")) throw new Error("会社IDが不正です。");
  return path.join(root, "instances", id);
}
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}
export function notionId(value) {
  const raw = String(value).split(/[?#]/)[0];
  const match = raw.match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/ig)?.at(-1);
  if (!match) throw new Error("Notionの親ページURLまたはIDを確認してください。");
  return match.replaceAll("-", "").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
}
