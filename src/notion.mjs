import { notionId } from "./config.mjs";
const title = { title: {} }, text = { rich_text: {} }, date = { date: {} }, url = { url: {} };
const select = (names) => ({ select: { options: names.map((name) => ({ name })) } });
export function schemas(config) {
  const result = {};
  if (config.features.includes("meetings")) Object.assign(result, {
    inbox: { name: "議事録インボックス", properties: { Name: title, ステータス: select(["未処理", "処理済み"]), 会議日: date, 登録者: text, 議事録リンク: url, 動画リンク: url, 会議名: select(config.meetings) } },
    tasks: { name: "社内タスク", properties: { Name: title, ステータス: select(["未着手", "進行中", "完了", "停滞"]), 担当者: text, 期限: date, 承認: { checkbox: {} }, 元会議: text, 登録キー: text } },
    agenda: { name: "次回MTG準備メモ", properties: { Name: title, 会議名: select(config.meetings), 対象日: date, 前回会議日: date, 前回議事録: url, ステータス: select(["提案", "確認済み"]) } },
  });
  if (config.features.includes("reports")) result.reports = { name: "社員稼働レポート", properties: { 日付: title, 社員: text, "稼働時間(h)": { number: {} }, 作業内容の要約: text, "無駄・非効率が疑われる点": text, 自動化できそうな作業: text, ウィンドウ切替回数: { number: {} }, 識別子: text } };
  return result;
}
export function notionClient(token, fetchImpl = fetch) {
  if (!token) throw new Error("Notionトークンが未設定です。");
  return async (endpoint, method = "GET", body) => {
    const response = await fetchImpl(`https://api.notion.com/v1${endpoint}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Notion ${response.status}: ${response.status === 404 ? "親ページの接続共有とIDを確認してください" : "権限・トークン・接続を確認してください"}`);
    return response.json();
  };
}
export async function children(api, parent) {
  const all = []; let cursor;
  do {
    const query = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
    const page = await api(`/blocks/${parent}/children?${query}`);
    all.push(...page.results);
    if (page.has_more && !page.next_cursor) throw new Error("Notionページネーションが不完全です。");
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return all;
}
export async function checkDatabase(api, id, schema, parent) {
  const db = await api(`/databases/${notionId(id)}`);
  if (parent && (!db.parent?.page_id || notionId(db.parent.page_id) !== notionId(parent))) throw new Error(`${schema.name}: 指定した親ページに属していません。`);
  if (db.data_sources?.length !== 1) throw new Error(`${schema.name}: データソースが1つの専用DBを指定してください。`);
  const source = await api(`/data_sources/${db.data_sources[0].id}`);
  for (const [name, property] of Object.entries(schema.properties)) {
    const expected = Object.keys(property)[0];
    if (source.properties?.[name]?.type !== expected) throw new Error(`${schema.name}: ${name}列の型が${expected}ではありません。`);
    if (expected === "select") {
      const options = new Set(source.properties[name].select.options.map((o) => o.name));
      if (property.select.options.some((o) => !options.has(o.name))) throw new Error(`${schema.name}: ${name}の選択肢が不足しています。`);
    }
  }
  return { id: db.id, dataSourceId: source.id, url: db.url ?? `https://www.notion.so/${db.id.replaceAll("-", "")}` };
}
export async function planProvision(config, api) {
  const parent = notionId(config.notionParent);
  await api(`/pages/${parent}`);
  const existing = await children(api, parent);
  const plan = [];
  for (const [key, schema] of Object.entries(schemas(config))) {
    const name = `${config.name} · ${schema.name} [${config.id}]`;
    let id = config.databases?.[key]?.id;
    if (!id) {
      const matches = existing.filter((block) => block.type === "child_database" && [name, schema.name].includes(block.child_database.title));
      if (matches.length > 1) throw new Error(`${name}: 同名DBが複数あります。IDを指定してください。`);
      id = matches[0]?.id;
    }
    const database = id ? await checkDatabase(api, id, schema, parent) : null;
    plan.push({ key, name, schema, action: id ? "reuse" : "create", database });
  }
  const ids = plan.filter((item) => item.database).map((item) => notionId(item.database.id));
  if (new Set(ids).size !== ids.length) throw new Error("同じDBを複数の役割に指定できません。");
  return plan;
}
export async function provision(config, api, checkpoint, approvedPlan) {
  const plan = await planProvision(config, api);
  const signature = (items) => JSON.stringify(items.map(({ key, action, database }) => [key, action, database?.id]));
  if (approvedPlan && signature(approvedPlan) !== signature(plan)) throw new Error("確認後にNotionの構成が変わりました。変更せず停止します。再実行して計画を確認してください。");
  const parent = notionId(config.notionParent);
  config.databases ??= {};
  for (const { key, name, schema, database } of plan) {
    let id = database?.id;
    if (!id) {
      // Never blindly retry a creation after an uncertain response; rediscover on rerun.
      const db = await api("/databases", "POST", { parent: { type: "page_id", page_id: parent }, title: [{ type: "text", text: { content: name } }], initial_data_source: { properties: schema.properties } });
      id = db.id;
      config.databases[key] = { id };
      await checkpoint(config);
    }
    config.databases[key] = await checkDatabase(api, id, schema, parent);
    await checkpoint(config);
  }
  return config;
}
