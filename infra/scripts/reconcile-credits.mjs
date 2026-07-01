import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { creditSourceRemainders } from "../../packages/shared/dist/index.js";

// 积分账务离线对账脚本。
// 校验项（任一不通过则非零退出）：
//   1. account.balance === sum(该用户所有 ledger.amount)
//   2. account.totalEarned === sum(正向 amount)，totalSpent === sum(负向 amount 绝对值)
//   3. idempotencyKey 全局唯一（防重放重复发放/退款）
//   4. 每个正向来源批次 FIFO 剩余额 >= 0（EXPIRE 不超发、消耗不超领）
//   5. balanceAfter 单调可追溯：账户最终 balance 与最后一条流水的 balanceAfter 一致
//   6. account.balance >= 0（不可被刷成负数）

const storePath = resolve(process.env.IMAGORA_STORE_PATH ?? "data/imagora-store.json");

const raw = await readFile(storePath, "utf8").catch((error) => {
  console.error(`[reconcile] 无法读取积分存储文件 ${storePath}: ${error.message}`);
  process.exit(2);
});

/** @type {{ creditAccounts: any[]; creditLedgerEntries: any[] }} */
const data = JSON.parse(raw);
const accounts = data.creditAccounts ?? [];
const entries = data.creditLedgerEntries ?? [];

const problems = [];

// 校验 3：idempotencyKey 全局唯一
const seenKeys = new Map();
for (const entry of entries) {
  const count = (seenKeys.get(entry.idempotencyKey) ?? 0) + 1;
  seenKeys.set(entry.idempotencyKey, count);
}
for (const [key, count] of seenKeys) {
  if (count > 1) {
    problems.push(`idempotencyKey 重复 ${count} 次：${key}`);
  }
}

// 按用户分组
const byUser = new Map();
for (const entry of entries) {
  const list = byUser.get(entry.userId) ?? [];
  list.push(entry);
  byUser.set(entry.userId, list);
}

for (const account of accounts) {
  const userEntries = (byUser.get(account.userId) ?? []).slice().sort((a, b) => {
    const at = new Date(a.createdAt).getTime();
    const bt = new Date(b.createdAt).getTime();
    return at - bt;
  });

  const sumAll = userEntries.reduce((sum, entry) => sum + entry.amount, 0);
  const sumEarned = userEntries.filter((e) => e.amount > 0).reduce((sum, e) => sum + e.amount, 0);
  const sumSpent = userEntries.filter((e) => e.amount < 0).reduce((sum, e) => sum + Math.abs(e.amount), 0);

  // 校验 1
  if (account.balance !== sumAll) {
    problems.push(
      `用户 ${account.userId} 余额不平：balance=${account.balance}，流水累计=${sumAll}，差额=${account.balance - sumAll}`
    );
  }
  // 校验 2
  if (account.totalEarned !== sumEarned) {
    problems.push(`用户 ${account.userId} totalEarned 不平：记录=${account.totalEarned}，正向流水累计=${sumEarned}`);
  }
  if (account.totalSpent !== sumSpent) {
    problems.push(`用户 ${account.userId} totalSpent 不平：记录=${account.totalSpent}，负向流水累计=${sumSpent}`);
  }
  // 校验 6
  if (account.balance < 0) {
    problems.push(`用户 ${account.userId} 余额为负：${account.balance}`);
  }
  // 校验 5
  if (userEntries.length > 0) {
    const lastBalanceAfter = userEntries[userEntries.length - 1].balanceAfter;
    if (lastBalanceAfter !== account.balance) {
      problems.push(
        `用户 ${account.userId} 末条流水 balanceAfter=${lastBalanceAfter} 与账户 balance=${account.balance} 不一致`
      );
    }
  }
  // 校验 4：批次剩余非负
  const remainders = creditSourceRemainders(userEntries);
  for (const [sourceId, remainder] of remainders) {
    if (remainder < 0) {
      problems.push(`用户 ${account.userId} 批次 ${sourceId.slice(0, 8)} 剩余为负：${remainder}（消耗或过期超领）`);
    }
  }
}

// 校验：存在流水但没有账户的孤儿用户
for (const userId of byUser.keys()) {
  if (!accounts.some((account) => account.userId === userId)) {
    problems.push(`用户 ${userId} 有积分流水但无积分账户`);
  }
}

console.log(`[reconcile] 存储文件：${storePath}`);
console.log(`[reconcile] 账户数：${accounts.length}，流水条数：${entries.length}`);

if (problems.length > 0) {
  console.error(`[reconcile] 发现 ${problems.length} 处账务异常：`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log("[reconcile] 全部账户余额、流水方向、批次剩余与幂等键校验通过。");
