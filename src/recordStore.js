// 记录存储：只负责持久化与读取，不内嵌任何业务规则。
// 数据落盘为单个 JSON 文件，包含批次、测量记录、封存快照与失效快照。

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const EMPTY = { batches: [], measurements: [], seals: [], invalidatedSnapshots: [] };

export function createRecordStore(filePath) {
  // 事务串行化：所有“读-改-写”排成一条链，
  // 并发请求逐一执行，后者读到的是前者落库后的状态。
  let queue = Promise.resolve();

  async function load() {
    if (!existsSync(filePath)) return structuredClone(EMPTY);
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    return { ...structuredClone(EMPTY), ...raw };
  }

  async function save(db) {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, filePath); // 原子替换，避免半截文件
  }

  return {
    /**
     * 在串行锁内执行“读-改-写”。
     * mutator 抛错时不落库（用于 409/校验失败等场景）。
     */
    transact(mutator) {
      const run = queue.then(async () => {
        const db = await load();
        const result = await mutator(db);
        await save(db);
        return result;
      });
      queue = run.catch(() => {}); // 失败不阻塞后续事务
      return run;
    },

    /** 只读快照 */
    read: load,
  };
}
