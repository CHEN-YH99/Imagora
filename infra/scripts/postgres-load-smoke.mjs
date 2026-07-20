import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const defaultRequests = 60;
const defaultConcurrency = 6;
const defaultP95Ms = 250;
const defaultAverageMs = 150;
const defaultFailureRate = 0;

export function summarizeLatencies(latencies, requests, failures) {
  const sorted = [...latencies].sort((left, right) => left - right);
  const successful = sorted.length;
  return {
    requests,
    failures,
    failureRate: round(requests === 0 ? 0 : failures / requests),
    averageMs: round(successful === 0 ? 0 : sorted.reduce((sum, value) => sum + value, 0) / successful),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99))
  };
}

async function main() {
  const databaseUrl = process.env.POSTGRES_LOAD_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("POSTGRES_LOAD_DATABASE_URL or DATABASE_URL is required");
  }
  process.env.DATABASE_URL = databaseUrl;

  const { PrismaClient } = await import("../../packages/database/generated/client/index.js");
  const prisma = new PrismaClient();
  const settings = readSettings();
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userId = `load-user-${runId}`;
  const planId = `load-plan-${runId}`;

  try {
    await prepareFixture(prisma, { userId, planId, runId, requests: settings.requests });
    const operations = createOperations(prisma, { userId, planId, runId, pageSize: settings.pageSize });
    const targets = [];
    for (const operation of operations) {
      targets.push(await benchmark(operation.name, operation.run, settings));
    }

    const summary = {
      database: "postgresql",
      requestsPerTarget: settings.requests,
      concurrency: settings.concurrency,
      thresholds: {
        averageMs: settings.averageMs,
        p95Ms: settings.p95Ms,
        failureRateMax: settings.failureRateMax
      },
      targets,
      passed: targets.every((target) => target.passed)
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.passed) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.$disconnect();
  }
}

function createOperations(prisma, fixture) {
  let sequence = 0;
  return [
    {
      name: "create_order",
      run: () => {
        sequence += 1;
        return prisma.order.create({
          data: {
            userId: fixture.userId,
            planId: fixture.planId,
            orderNo: `LOAD-${fixture.runId}-${sequence}`,
            amountCents: 990,
            currency: "CNY",
            paymentProvider: "mock",
            status: "PENDING"
          },
          select: { id: true }
        });
      }
    },
    {
      name: "spend_credits",
      run: async () => {
        const operationSequence = ++sequence;
        await prisma.$transaction(async (transaction) => {
          const account = await transaction.userCreditAccount.update({
            where: { userId: fixture.userId },
            data: { balance: { decrement: 1 }, totalSpent: { increment: 1 } },
            select: { balance: true }
          });
          await transaction.creditLedgerEntry.create({
            data: {
              userId: fixture.userId,
              type: "SPEND",
              amount: -1,
              balanceAfter: account.balance,
              sourceType: "TASK",
              sourceId: `load-credit-${operationSequence}`,
              idempotencyKey: `load-credit-${fixture.runId}-${operationSequence}`,
              remark: "PostgreSQL load baseline"
            }
          });
        });
      }
    },
    {
      name: "create_generation_task",
      run: () => {
        sequence += 1;
        return prisma.generationTask.create({
          data: {
            userId: fixture.userId,
            clientRequestId: `load-task-${fixture.runId}-${sequence}`,
            prompt: "PostgreSQL performance baseline",
            style: "realistic",
            aspectRatio: "1:1",
            width: 1024,
            height: 1024,
            quantity: 1,
            quality: "standard",
            modelProvider: "mock",
            modelName: "mock:default",
            creditCost: 1,
            status: "PENDING"
          },
          select: { id: true }
        });
      }
    },
    {
      name: "paginate_orders",
      run: () =>
        prisma.order.findMany({
          where: { userId: fixture.userId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: fixture.pageSize,
          select: { id: true, orderNo: true, status: true, createdAt: true }
        })
    },
    {
      name: "paginate_generation_tasks",
      run: () =>
        prisma.generationTask.findMany({
          where: { userId: fixture.userId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: fixture.pageSize,
          select: { id: true, status: true, creditCost: true, createdAt: true }
        })
    }
  ];
}

async function prepareFixture(prisma, fixture) {
  await prisma.user.create({
    data: {
      id: fixture.userId,
      email: `${fixture.userId}@load.imagora.local`,
      passwordHash: "load-baseline",
      nickname: "PostgreSQL Load Baseline",
      creditAccount: {
        create: {
          balance: fixture.requests + 100,
          totalEarned: fixture.requests + 100,
          totalSpent: 0
        }
      }
    }
  });
  await prisma.plan.create({
    data: {
      id: fixture.planId,
      name: `Load Baseline ${fixture.runId}`,
      description: "PostgreSQL performance baseline fixture",
      priceCents: 990,
      currency: "CNY",
      credits: 100,
      status: "ACTIVE",
      sortOrder: 9999
    }
  });
}

async function benchmark(name, operation, settings) {
  const latencies = [];
  let failures = 0;
  let nextIndex = 0;
  const workers = Array.from({ length: settings.concurrency }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= settings.requests) {
        return;
      }
      const startedAt = performance.now();
      try {
        await operation(currentIndex);
        latencies.push(performance.now() - startedAt);
      } catch {
        failures += 1;
      }
    }
  });
  await Promise.all(workers);
  const metrics = summarizeLatencies(latencies, settings.requests, failures);
  return {
    name,
    ...metrics,
    passed:
      metrics.averageMs <= settings.averageMs &&
      metrics.p95Ms <= settings.p95Ms &&
      metrics.failureRate <= settings.failureRateMax
  };
}

function readSettings() {
  return {
    requests: readPositiveInt("POSTGRES_LOAD_REQUESTS", defaultRequests),
    concurrency: readPositiveInt("POSTGRES_LOAD_CONCURRENCY", defaultConcurrency),
    pageSize: readPositiveInt("POSTGRES_LOAD_PAGE_SIZE", 20),
    p95Ms: readPositiveNumber("POSTGRES_LOAD_P95_MS", defaultP95Ms),
    averageMs: readPositiveNumber("POSTGRES_LOAD_AVG_MS", defaultAverageMs),
    failureRateMax: readRate("POSTGRES_LOAD_FAILURE_RATE_MAX", defaultFailureRate)
  };
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  return values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)];
}

function readPositiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readRate(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function round(value) {
  return Number(value.toFixed(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
