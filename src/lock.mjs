import fs from "node:fs/promises";
import path from "node:path";
export async function withLock(dir, operation, fn) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, `${operation}.lock`);
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`${operation}は実行中です。異常停止の場合はREADMEのロック復旧手順を確認してください。`); throw error; }
  try {
    await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
    return await fn();
  } finally { await fs.rm(lock, { recursive: true, force: true }); }
}
