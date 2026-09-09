import fs from "node:fs/promises";
import path from "node:path";
import { root } from "./config.mjs";
export function expand(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing template value: ${key}`);
    return values[key];
  });
}
export async function render(config, dir) {
  const instructions = {
    COMPANY: config.name, TIMEZONE: config.timezone,
    CONFIG: JSON.stringify({ company: config.name, timezone: config.timezone, meetings: config.meetings, members: config.members, cleanupDays: config.cleanupDays, databases: config.databases }, null, 2),
  };
  const target = path.join(dir, "workspace");
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of await fs.readdir(path.join(root, "templates"))) {
    const text = await fs.readFile(path.join(root, "templates", name), "utf8");
    await fs.writeFile(path.join(target, name), expand(text, instructions), { mode: 0o600 });
  }
  return target;
}
