import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type { CreditLedgerEntry, Plan, StoreData, User } from "@imagora/shared";

const defaultPath = resolve(process.cwd(), "data", "imagora-store.json");

export interface Store {
  read(): Promise<StoreData>;
  write(data: StoreData): Promise<void>;
  update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T>;
}

export function createStore(): Store {
  return process.env.DATA_STORE === "prisma" ? new PrismaStore() : new JsonStore();
}

export class JsonStore implements Store {
  readonly filePath: string;

  constructor(filePath = process.env.IMAGORA_STORE_PATH ? resolve(process.env.IMAGORA_STORE_PATH) : defaultPath) {
    this.filePath = filePath;
  }

  async read(): Promise<StoreData> {
    await this.ensureInitialized();
    const content = await readFile(this.filePath, "utf8");
    return normalizeStoreData(JSON.parse(content) as Partial<StoreData>);
  }

  async write(data: StoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  async update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    const data = await this.read();
    const result = await mutate(data);
    await this.write(data);
    return result;
  }

  private async ensureInitialized(): Promise<void> {
    try {
      await readFile(this.filePath, "utf8");
    } catch {
      await this.write(createSeedData());
    }
  }
}

export class PrismaStore implements Store {
  private readonly prisma: PrismaClient;

  constructor(prisma = new PrismaClient()) {
    this.prisma = prisma;
  }

  async read(): Promise<StoreData> {
    await this.ensureSeeded();
    const [
      users,
      sessions,
      creditAccounts,
      creditLedgerEntries,
      generationTasks,
      generatedImages,
      imageFavorites,
      plans,
      orders,
      paymentEvents,
      safetyEvents,
      safetyRules,
      adminAuditLogs
    ] = await Promise.all([
      this.prisma.user.findMany(),
      this.prisma.session.findMany(),
      this.prisma.userCreditAccount.findMany(),
      this.prisma.creditLedgerEntry.findMany(),
      this.prisma.generationTask.findMany(),
      this.prisma.generatedImage.findMany(),
      this.prisma.imageFavorite.findMany(),
      this.prisma.plan.findMany(),
      this.prisma.order.findMany(),
      this.prisma.paymentEvent.findMany(),
      this.prisma.safetyEvent.findMany(),
      this.prisma.safetyRule.findMany(),
      this.prisma.adminAuditLog.findMany()
    ]);

    return {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        passwordHash: user.passwordHash,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null
      })),
      sessions: sessions.map((session) => ({
        token: session.token,
        userId: session.userId,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString()
      })),
      creditAccounts: creditAccounts.map((account) => ({
        userId: account.userId,
        balance: account.balance,
        totalEarned: account.totalEarned,
        totalSpent: account.totalSpent,
        updatedAt: account.updatedAt.toISOString()
      })),
      creditLedgerEntries: creditLedgerEntries.map((entry) => ({
        id: entry.id,
        userId: entry.userId,
        type: entry.type,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        idempotencyKey: entry.idempotencyKey,
        remark: entry.remark,
        createdAt: entry.createdAt.toISOString()
      })),
      generationTasks: generationTasks.map((task) => ({
        id: task.id,
        userId: task.userId,
        clientRequestId: task.clientRequestId,
        prompt: task.prompt,
        negativePrompt: task.negativePrompt,
        style: task.style as StoreData["generationTasks"][number]["style"],
        aspectRatio: task.aspectRatio as StoreData["generationTasks"][number]["aspectRatio"],
        width: task.width,
        height: task.height,
        quantity: task.quantity,
        quality: task.quality as StoreData["generationTasks"][number]["quality"],
        modelProvider: task.modelProvider,
        modelName: task.modelName,
        status: task.status,
        creditCost: task.creditCost,
        failureCode: task.failureCode,
        failureMessage: task.failureMessage,
        startedAt: task.startedAt?.toISOString() ?? null,
        completedAt: task.completedAt?.toISOString() ?? null,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString()
      })),
      generatedImages: generatedImages.map((image) => ({
        id: image.id,
        taskId: image.taskId,
        userId: image.userId,
        storageKey: image.storageKey,
        thumbnailKey: image.thumbnailKey,
        publicUrl: image.publicUrl ?? "",
        width: image.width,
        height: image.height,
        fileSize: image.fileSize,
        mimeType: image.mimeType,
        safetyStatus: image.safetyStatus,
        visibility: image.visibility,
        deletedAt: image.deletedAt?.toISOString() ?? null,
        createdAt: image.createdAt.toISOString()
      })),
      imageFavorites: imageFavorites.map((favorite) => ({
        userId: favorite.userId,
        imageId: favorite.imageId,
        createdAt: favorite.createdAt.toISOString()
      })),
      plans: plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        description: plan.description,
        priceCents: plan.priceCents,
        currency: plan.currency,
        credits: plan.credits,
        validDays: plan.validDays,
        status: plan.status,
        sortOrder: plan.sortOrder,
        createdAt: plan.createdAt.toISOString(),
        updatedAt: plan.updatedAt.toISOString()
      })),
      orders: orders.map((order) => ({
        id: order.id,
        userId: order.userId,
        planId: order.planId,
        orderNo: order.orderNo,
        amountCents: order.amountCents,
        currency: order.currency,
        paymentProvider: order.paymentProvider,
        paymentIntentId: order.paymentIntentId,
        status: order.status,
        paidAt: order.paidAt?.toISOString() ?? null,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString()
      })),
      paymentEvents: paymentEvents.map((event) => ({
        id: event.id,
        provider: event.provider,
        providerEventId: event.providerEventId,
        orderId: event.orderId,
        eventType: event.eventType,
        payload: event.payload as Record<string, unknown>,
        processedAt: event.processedAt.toISOString(),
        createdAt: event.createdAt.toISOString()
      })),
      safetyEvents: safetyEvents.map((event) => ({
        id: event.id,
        userId: event.userId,
        targetType: event.targetType as StoreData["safetyEvents"][number]["targetType"],
        targetId: event.targetId,
        status: event.status,
        reasonCode: event.reasonCode,
        reasonMessage: event.reasonMessage,
        provider: event.provider,
        createdAt: event.createdAt.toISOString()
      })),
      safetyRules: safetyRules.map((rule) => ({
        id: rule.id,
        term: rule.term,
        action: rule.action,
        status: rule.status,
        createdAt: rule.createdAt.toISOString(),
        updatedAt: rule.updatedAt.toISOString()
      })),
      adminAuditLogs: adminAuditLogs.map((log) => ({
        id: log.id,
        adminUserId: log.adminUserId,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        before: log.before as Record<string, unknown> | null,
        after: log.after as Record<string, unknown> | null,
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        createdAt: log.createdAt.toISOString()
      }))
    };
  }

  async write(data: StoreData): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.adminAuditLog.deleteMany();
      await tx.safetyRule.deleteMany();
      await tx.safetyEvent.deleteMany();
      await tx.paymentEvent.deleteMany();
      await tx.order.deleteMany();
      await tx.imageFavorite.deleteMany();
      await tx.generatedImage.deleteMany();
      await tx.generationTask.deleteMany();
      await tx.creditLedgerEntry.deleteMany();
      await tx.userCreditAccount.deleteMany();
      await tx.session.deleteMany();
      await tx.plan.deleteMany();
      await tx.user.deleteMany();

      if (data.users.length) {
        await tx.user.createMany({
          data: data.users.map((user) => ({
            id: user.id,
            email: user.email,
            passwordHash: user.passwordHash,
            nickname: user.nickname,
            avatarUrl: user.avatarUrl,
            role: user.role,
            status: user.status,
            createdAt: toDate(user.createdAt),
            updatedAt: toDate(user.updatedAt),
            lastLoginAt: user.lastLoginAt ? toDate(user.lastLoginAt) : null
          }))
        });
      }
      if (data.plans.length) {
        await tx.plan.createMany({
          data: data.plans.map((plan) => ({
            id: plan.id,
            name: plan.name,
            description: plan.description,
            priceCents: plan.priceCents,
            currency: plan.currency,
            credits: plan.credits,
            validDays: plan.validDays,
            status: plan.status,
            sortOrder: plan.sortOrder,
            createdAt: toDate(plan.createdAt),
            updatedAt: toDate(plan.updatedAt)
          }))
        });
      }
      if (data.sessions.length) {
        await tx.session.createMany({
          data: data.sessions.map((session) => ({
            token: session.token,
            userId: session.userId,
            createdAt: toDate(session.createdAt),
            expiresAt: toDate(session.expiresAt)
          }))
        });
      }
      if (data.creditAccounts.length) {
        await tx.userCreditAccount.createMany({
          data: data.creditAccounts.map((account) => ({
            userId: account.userId,
            balance: account.balance,
            totalEarned: account.totalEarned,
            totalSpent: account.totalSpent,
            updatedAt: toDate(account.updatedAt)
          }))
        });
      }
      if (data.creditLedgerEntries.length) {
        await tx.creditLedgerEntry.createMany({
          data: data.creditLedgerEntries.map((entry) => ({
            id: entry.id,
            userId: entry.userId,
            type: entry.type,
            amount: entry.amount,
            balanceAfter: entry.balanceAfter,
            sourceType: entry.sourceType,
            sourceId: entry.sourceId,
            idempotencyKey: entry.idempotencyKey,
            remark: entry.remark,
            createdAt: toDate(entry.createdAt)
          }))
        });
      }
      if (data.generationTasks.length) {
        await tx.generationTask.createMany({
          data: data.generationTasks.map((task) => ({
            id: task.id,
            userId: task.userId,
            clientRequestId: task.clientRequestId,
            prompt: task.prompt,
            negativePrompt: task.negativePrompt,
            style: task.style,
            aspectRatio: task.aspectRatio,
            width: task.width,
            height: task.height,
            quantity: task.quantity,
            quality: task.quality,
            modelProvider: task.modelProvider,
            modelName: task.modelName,
            status: task.status,
            creditCost: task.creditCost,
            failureCode: task.failureCode,
            failureMessage: task.failureMessage,
            startedAt: task.startedAt ? toDate(task.startedAt) : null,
            completedAt: task.completedAt ? toDate(task.completedAt) : null,
            createdAt: toDate(task.createdAt),
            updatedAt: toDate(task.updatedAt)
          }))
        });
      }
      if (data.generatedImages.length) {
        await tx.generatedImage.createMany({
          data: data.generatedImages.map((image) => ({
            id: image.id,
            taskId: image.taskId,
            userId: image.userId,
            storageKey: image.storageKey,
            thumbnailKey: image.thumbnailKey,
            publicUrl: image.publicUrl,
            width: image.width,
            height: image.height,
            fileSize: image.fileSize,
            mimeType: image.mimeType,
            safetyStatus: image.safetyStatus,
            visibility: image.visibility,
            deletedAt: image.deletedAt ? toDate(image.deletedAt) : null,
            createdAt: toDate(image.createdAt)
          }))
        });
      }
      if (data.imageFavorites.length) {
        await tx.imageFavorite.createMany({
          data: data.imageFavorites.map((favorite) => ({
            userId: favorite.userId,
            imageId: favorite.imageId,
            createdAt: toDate(favorite.createdAt)
          }))
        });
      }
      if (data.orders.length) {
        await tx.order.createMany({
          data: data.orders.map((order) => ({
            id: order.id,
            userId: order.userId,
            planId: order.planId,
            orderNo: order.orderNo,
            amountCents: order.amountCents,
            currency: order.currency,
            paymentProvider: order.paymentProvider,
            paymentIntentId: order.paymentIntentId,
            status: order.status,
            paidAt: order.paidAt ? toDate(order.paidAt) : null,
            createdAt: toDate(order.createdAt),
            updatedAt: toDate(order.updatedAt)
          }))
        });
      }
      if (data.paymentEvents.length) {
        await tx.paymentEvent.createMany({
          data: data.paymentEvents.map((event) => ({
            id: event.id,
            provider: event.provider,
            providerEventId: event.providerEventId,
            orderId: event.orderId,
            eventType: event.eventType,
            payload: event.payload as Prisma.InputJsonValue,
            processedAt: toDate(event.processedAt),
            createdAt: toDate(event.createdAt)
          }))
        });
      }
      if (data.safetyEvents.length) {
        await tx.safetyEvent.createMany({
          data: data.safetyEvents.map((event) => ({
            id: event.id,
            userId: event.userId,
            targetType: event.targetType,
            targetId: event.targetId,
            status: event.status,
            reasonCode: event.reasonCode,
            reasonMessage: event.reasonMessage,
            provider: event.provider,
            createdAt: toDate(event.createdAt)
          }))
        });
      }
      if (data.safetyRules.length) {
        await tx.safetyRule.createMany({
          data: data.safetyRules.map((rule) => ({
            id: rule.id,
            term: rule.term,
            action: rule.action,
            status: rule.status,
            createdAt: toDate(rule.createdAt),
            updatedAt: toDate(rule.updatedAt)
          }))
        });
      }
      if (data.adminAuditLogs.length) {
        await tx.adminAuditLog.createMany({
          data: data.adminAuditLogs.map((log) => ({
            id: log.id,
            adminUserId: log.adminUserId,
            action: log.action,
            targetType: log.targetType,
            targetId: log.targetId,
            before: log.before === null ? Prisma.JsonNull : (log.before as Prisma.InputJsonValue),
            after: log.after === null ? Prisma.JsonNull : (log.after as Prisma.InputJsonValue),
            ipAddress: log.ipAddress,
            userAgent: log.userAgent,
            createdAt: toDate(log.createdAt)
          }))
        });
      }
    });
  }

  async update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    const data = await this.read();
    const result = await mutate(data);
    await this.write(data);
    return result;
  }

  private async ensureSeeded(): Promise<void> {
    const userCount = await this.prisma.user.count();
    if (userCount === 0) {
      await this.write(createSeedData());
    }
  }
}

export function createSeedData(): StoreData {
  const now = new Date().toISOString();
  const adminId = randomUUID();
  const demoId = randomUUID();
  return {
    users: [
      {
        id: adminId,
        email: "admin@imagora.local",
        passwordHash: hashPassword("Admin123!"),
        nickname: "Imagora Admin",
        avatarUrl: null,
        role: "ADMIN",
        status: "ACTIVE",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null
      },
      {
        id: demoId,
        email: "demo@imagora.local",
        passwordHash: hashPassword("Demo123!"),
        nickname: "Demo Creator",
        avatarUrl: null,
        role: "USER",
        status: "ACTIVE",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null
      }
    ],
    sessions: [],
    creditAccounts: [
      { userId: adminId, balance: 9999, totalEarned: 9999, totalSpent: 0, updatedAt: now },
      { userId: demoId, balance: 1240, totalEarned: 1240, totalSpent: 0, updatedAt: now }
    ],
    creditLedgerEntries: [
      seedLedger(adminId, 9999, "Initial admin credits", now),
      seedLedger(demoId, 1240, "Demo welcome credits", now)
    ],
    generationTasks: [],
    generatedImages: [],
    imageFavorites: [],
    plans: seedPlans(now),
    orders: [],
    paymentEvents: [],
    safetyEvents: [],
    safetyRules: seedSafetyRules(now),
    adminAuditLogs: []
  };
}

export function hashPassword(password: string): string {
  const salt = randomUUID().replace(/-/g, "");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, expectedHash] = encoded.split(":");
  if (algorithm !== "scrypt" || !salt || !expectedHash) {
    return false;
  }
  const actual = Buffer.from(scryptSync(password, salt, 64).toString("hex"), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function withoutPassword(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

function seedLedger(userId: string, amount: number, remark: string, now: string): CreditLedgerEntry {
  return {
    id: randomUUID(),
    userId,
    type: "GRANT",
    amount,
    balanceAfter: amount,
    sourceType: "SYSTEM",
    sourceId: "seed",
    idempotencyKey: `seed:${userId}`,
    remark,
    createdAt: now
  };
}

function seedPlans(now: string): Plan[] {
  return [
    {
      id: "starter",
      name: "Starter",
      description: "220 credits for prompt exploration",
      priceCents: 900,
      currency: "USD",
      credits: 220,
      validDays: 30,
      status: "ACTIVE",
      sortOrder: 10,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "creator",
      name: "Creator",
      description: "620 credits with HD downloads",
      priceCents: 1900,
      currency: "USD",
      credits: 620,
      validDays: 60,
      status: "ACTIVE",
      sortOrder: 20,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "studio",
      name: "Studio",
      description: "1850 credits for teams and ecommerce operators",
      priceCents: 4900,
      currency: "USD",
      credits: 1850,
      validDays: 90,
      status: "ACTIVE",
      sortOrder: 30,
      createdAt: now,
      updatedAt: now
    }
  ];
}

function seedSafetyRules(now: string) {
  return [
    {
      id: randomUUID(),
      term: "child abuse",
      action: "BLOCK" as const,
      status: "ACTIVE" as const,
      createdAt: now,
      updatedAt: now
    },
    {
      id: randomUUID(),
      term: "sexual violence",
      action: "BLOCK" as const,
      status: "ACTIVE" as const,
      createdAt: now,
      updatedAt: now
    },
    {
      id: randomUUID(),
      term: "terrorist",
      action: "BLOCK" as const,
      status: "ACTIVE" as const,
      createdAt: now,
      updatedAt: now
    }
  ];
}

function normalizeStoreData(data: Partial<StoreData>): StoreData {
  const now = new Date().toISOString();
  return {
    users: data.users ?? [],
    sessions: data.sessions ?? [],
    creditAccounts: data.creditAccounts ?? [],
    creditLedgerEntries: data.creditLedgerEntries ?? [],
    generationTasks: data.generationTasks ?? [],
    generatedImages: data.generatedImages ?? [],
    imageFavorites: data.imageFavorites ?? [],
    plans: data.plans ?? seedPlans(now),
    orders: data.orders ?? [],
    paymentEvents: data.paymentEvents ?? [],
    safetyEvents: data.safetyEvents ?? [],
    safetyRules: data.safetyRules ?? seedSafetyRules(now),
    adminAuditLogs: data.adminAuditLogs ?? []
  };
}

function toDate(value: string): Date {
  return new Date(value);
}
