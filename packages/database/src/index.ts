import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "../generated/client/index.js";
import { generationMetadataFromTask } from "@imagora/shared";
import type { CreditLedgerEntry, GenerationMetadata, Plan, SafetyAppeal, StoreData, User } from "@imagora/shared";
import { persistStoreDiff } from "./prisma-store-persistence.js";

const workspaceRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultPath = resolve(workspaceRoot, "data", "imagora-store.json");

export interface Store {
  read(): Promise<StoreData>;
  write(data: StoreData): Promise<void>;
  update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T>;
}

export function createStore(): Store {
  if (process.env.DATA_STORE !== "prisma") {
    return new JsonStore();
  }

  const prismaStore = new PrismaStore();
  if (!allowPrismaDevelopmentFallback()) {
    return prismaStore;
  }

  return new DevelopmentFallbackStore(prismaStore, new JsonStore());
}

export class JsonStore implements Store {
  readonly filePath: string;
  private updateChain: Promise<void> = Promise.resolve();

  constructor(filePath = resolveStorePath(process.env.IMAGORA_STORE_PATH)) {
    this.filePath = filePath;
  }

  async read(): Promise<StoreData> {
    await this.ensureInitialized();
    return this.readUnlocked();
  }

  async write(data: StoreData): Promise<void> {
    await withFileLock(this.filePath, async () => {
      await this.writeUnlocked(data);
    });
  }

  async update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    let result: T | undefined;
    const operation = this.updateChain.then(async () => {
      await withFileLock(this.filePath, async () => {
        await this.ensureInitializedUnlocked();
        const data = await this.readUnlocked();
        result = await mutate(data);
        await this.writeUnlocked(data);
      });
    });
    this.updateChain = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
    return result as T;
  }

  private async readUnlocked(): Promise<StoreData> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const content = await readFile(this.filePath, "utf8");
        return normalizeStoreData(JSON.parse(content) as Partial<StoreData>);
      } catch (error) {
        if (attempt === 2 || !(error instanceof SyntaxError)) {
          throw error;
        }
        await sleep(20);
      }
    }
    throw new Error("JSON store read failed");
  }

  private async writeUnlocked(data: StoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }

  private async ensureInitialized(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      await this.ensureInitializedUnlocked();
    });
  }

  private async ensureInitializedUnlocked(): Promise<void> {
    try {
      await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      await this.writeUnlocked(createInitialData());
    }
  }
}

class DevelopmentFallbackStore implements Store {
  private activeFallback: Store | null = null;

  constructor(
    private readonly primary: Store,
    private readonly fallback: Store
  ) {}

  async read(): Promise<StoreData> {
    return this.run((store) => store.read());
  }

  async write(data: StoreData): Promise<void> {
    return this.run((store) => store.write(data));
  }

  async update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    return this.run((store) => store.update(mutate));
  }

  private async run<T>(operation: (store: Store) => Promise<T>): Promise<T> {
    if (this.activeFallback) {
      return operation(this.activeFallback);
    }

    try {
      return await operation(this.primary);
    } catch (error) {
      if (!isPrismaUnavailableError(error)) {
        throw error;
      }
      this.activeFallback = this.fallback;
      return operation(this.activeFallback);
    }
  }
}

export class PrismaStore implements Store {
  private readonly prisma: PrismaClient;
  private updateChain: Promise<void> = Promise.resolve();

  constructor(prisma = new PrismaClient()) {
    this.prisma = prisma;
  }

  async read(): Promise<StoreData> {
    await this.ensureSeeded();
    return this.readFromClient(this.prisma);
  }

  private async readFromClient(client: PrismaClient | Prisma.TransactionClient): Promise<StoreData> {
    const [
      users,
      sessions,
      passwordResetTokens,
      emailVerificationTokens,
      creditAccounts,
      creditLedgerEntries,
      generationTasks,
      referenceImages,
      generatedImages,
      imageFavorites,
      imageProjects,
      plans,
      orders,
      paymentEvents,
      safetyEvents,
      safetyRules,
      safetyAppeals,
      adminAuditLogs,
      operationalIncidents,
      alertNotifications
    ] = await Promise.all([
      client.user.findMany(),
      client.session.findMany(),
      client.passwordResetToken.findMany(),
      client.emailVerificationToken.findMany(),
      client.userCreditAccount.findMany(),
      client.creditLedgerEntry.findMany(),
      client.generationTask.findMany(),
      client.referenceImage.findMany(),
      client.generatedImage.findMany(),
      client.imageFavorite.findMany(),
      client.imageProject.findMany(),
      client.plan.findMany(),
      client.order.findMany(),
      client.paymentEvent.findMany(),
      client.safetyEvent.findMany(),
      client.safetyRule.findMany(),
      client.safetyAppeal.findMany(),
      client.adminAuditLog.findMany(),
      client.operationalIncident.findMany(),
      client.alertNotification.findMany()
    ]);

    const generationTaskViews: StoreData["generationTasks"] = generationTasks.map((task) => ({
      id: task.id,
      userId: task.userId,
      clientRequestId: task.clientRequestId,
      referenceImageId: task.referenceImageId,
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
      providerCostCents: task.providerCostCents,
      failureCode: task.failureCode,
      failureMessage: task.failureMessage,
      startedAt: task.startedAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString()
    }));

    return {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        passwordHash: user.passwordHash,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        role: user.role,
        status: user.status,
        emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
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
      passwordResetTokens: passwordResetTokens.map((token) => ({
        id: token.id,
        userId: token.userId,
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt.toISOString(),
        usedAt: token.usedAt?.toISOString() ?? null,
        createdAt: token.createdAt.toISOString()
      })),
      emailVerificationTokens: emailVerificationTokens.map((token) => ({
        id: token.id,
        userId: token.userId,
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt.toISOString(),
        usedAt: token.usedAt?.toISOString() ?? null,
        createdAt: token.createdAt.toISOString()
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
        expiresAt: entry.expiresAt?.toISOString() ?? null,
        createdAt: entry.createdAt.toISOString()
      })),
      generationTasks: generationTaskViews,
      referenceImages: referenceImages.map((image) => ({
        id: image.id,
        userId: image.userId,
        storageKey: image.storageKey,
        publicUrl: image.publicUrl ?? "",
        originalFileName: image.originalFileName,
        mimeType: image.mimeType as StoreData["referenceImages"][number]["mimeType"],
        fileSize: image.fileSize,
        width: image.width,
        height: image.height,
        contentHash: image.contentHash,
        safetyStatus: image.safetyStatus,
        createdAt: image.createdAt.toISOString(),
        expiresAt: image.expiresAt.toISOString(),
        deletedAt: image.deletedAt?.toISOString() ?? null
      })),
      generatedImages: generatedImages.map((image) => {
        const createdAt = image.createdAt.toISOString();
        return {
          id: image.id,
          taskId: image.taskId,
          userId: image.userId,
          projectId: image.projectId,
          storageKey: image.storageKey,
          thumbnailKey: image.thumbnailKey,
          thumbnailUrl: image.thumbnailUrl ?? image.publicUrl ?? "",
          publicUrl: image.publicUrl ?? "",
          width: image.width,
          height: image.height,
          fileSize: image.fileSize,
          mimeType: image.mimeType,
          safetyStatus: image.safetyStatus,
          visibility: image.visibility,
          generationMetadata: normalizeGenerationMetadata(
            image.generationMetadata,
            generationTaskViews.find((task) => task.id === image.taskId),
            { taskId: image.taskId, width: image.width, height: image.height, createdAt }
          ),
          deletedAt: image.deletedAt?.toISOString() ?? null,
          createdAt
        };
      }),
      imageFavorites: imageFavorites.map((favorite) => ({
        userId: favorite.userId,
        imageId: favorite.imageId,
        createdAt: favorite.createdAt.toISOString()
      })),
      imageProjects: imageProjects.map((project) => ({
        id: project.id,
        userId: project.userId,
        name: project.name,
        description: project.description,
        coverImageId: project.coverImageId,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
        archivedAt: project.archivedAt?.toISOString() ?? null
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
      safetyAppeals: safetyAppeals.map((appeal) => ({
        id: appeal.id,
        userId: appeal.userId,
        safetyEventId: appeal.safetyEventId,
        reason: appeal.reason,
        status: appeal.status as SafetyAppeal["status"],
        adminNote: appeal.adminNote ?? null,
        createdAt: appeal.createdAt.toISOString(),
        resolvedAt: appeal.resolvedAt?.toISOString() ?? null
      })),
      adminAuditLogs: adminAuditLogs.map((log) => ({
        id: log.id,
        adminUserId: log.adminUserId,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        reason: log.reason ?? null,
        before: log.before as Record<string, unknown> | null,
        after: log.after as Record<string, unknown> | null,
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        createdAt: log.createdAt.toISOString()
      })),
      operationalIncidents: operationalIncidents.map((incident) => ({
        id: incident.id,
        severity: incident.severity as StoreData["operationalIncidents"][number]["severity"],
        area: incident.area as StoreData["operationalIncidents"][number]["area"],
        status: incident.status as StoreData["operationalIncidents"][number]["status"],
        message: incident.message,
        errorCode: incident.errorCode,
        requestId: incident.requestId,
        userId: incident.userId,
        taskId: incident.taskId,
        orderId: incident.orderId,
        route: incident.route,
        createdAt: incident.createdAt.toISOString(),
        updatedAt: incident.updatedAt.toISOString(),
        resolvedAt: incident.resolvedAt?.toISOString() ?? null
      })),
      alertNotifications: alertNotifications.map((notification) => ({
        id: notification.id,
        alertId: notification.alertId,
        channel: notification.channel as StoreData["alertNotifications"][number]["channel"],
        status: notification.status as StoreData["alertNotifications"][number]["status"],
        severity: notification.severity as StoreData["alertNotifications"][number]["severity"],
        dedupeKey: notification.dedupeKey,
        message: notification.message,
        createdAt: notification.createdAt.toISOString(),
        sentAt: notification.sentAt.toISOString()
      }))
    };
  }

  async write(data: StoreData): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(73341001)");
        const before = await this.readFromClient(tx);
        await persistStoreDiff(tx, before, data);
      },
      { timeout: 30_000 }
    );
  }

  async update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    let result: T | undefined;
    const operation = this.updateChain.then(async () => {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(73341001)");
          await this.seedIfEmpty(tx);
          const data = await this.readFromClient(tx);
          const before = structuredClone(data);
          result = await mutate(data);
          await persistStoreDiff(tx, before, data);
        },
        { timeout: 30_000 }
      );
    });
    this.updateChain = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
    return result as T;
  }

  private async ensureSeeded(): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(73341001)");
        await this.seedIfEmpty(tx);
      },
      { timeout: 30_000 }
    );
  }

  private async seedIfEmpty(tx: Prisma.TransactionClient): Promise<void> {
    if ((await tx.user.count()) > 0) {
      return;
    }
    const before = await this.readFromClient(tx);
    await persistStoreDiff(tx, before, createInitialData());
  }
}

export function createInitialData(): StoreData {
  if (shouldSeedDemoData()) {
    return createSeedData();
  }

  const email = process.env.IMAGORA_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.IMAGORA_BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Store is empty. Set IMAGORA_BOOTSTRAP_ADMIN_EMAIL and IMAGORA_BOOTSTRAP_ADMIN_PASSWORD, or set IMAGORA_SEED_DEMO_DATA=true for local demos."
    );
  }

  return createBootstrapAdminData(email, password);
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
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null
      },
      {
        id: demoId,
        email: "demo@imagora.local",
        passwordHash: hashPassword("Demo123!"),
        nickname: "创作用户",
        avatarUrl: null,
        role: "USER",
        status: "ACTIVE",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null
      }
    ],
    sessions: [],
    passwordResetTokens: [],
    emailVerificationTokens: [],
    creditAccounts: [
      { userId: adminId, balance: 9999, totalEarned: 9999, totalSpent: 0, updatedAt: now },
      { userId: demoId, balance: 1240, totalEarned: 1240, totalSpent: 0, updatedAt: now }
    ],
    creditLedgerEntries: [
      seedLedger(adminId, 9999, "Initial admin credits", now),
      seedLedger(demoId, 1240, "新用户欢迎积分", now)
    ],
    generationTasks: [],
    referenceImages: [],
    generatedImages: [],
    imageFavorites: [],
    imageProjects: [],
    plans: seedPlans(now),
    orders: [],
    paymentEvents: [],
    safetyEvents: [],
    safetyRules: seedSafetyRules(now),
    safetyAppeals: [],
    adminAuditLogs: [],
    operationalIncidents: [],
    alertNotifications: []
  };
}

function createBootstrapAdminData(email: string, password: string): StoreData {
  const now = new Date().toISOString();
  const adminId = randomUUID();
  return {
    users: [
      {
        id: adminId,
        email,
        passwordHash: hashPassword(password),
        nickname: "Imagora Admin",
        avatarUrl: null,
        role: "ADMIN",
        status: "ACTIVE",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null
      }
    ],
    sessions: [],
    passwordResetTokens: [],
    emailVerificationTokens: [],
    creditAccounts: [{ userId: adminId, balance: 9999, totalEarned: 9999, totalSpent: 0, updatedAt: now }],
    creditLedgerEntries: [seedLedger(adminId, 9999, "Initial admin credits", now)],
    generationTasks: [],
    referenceImages: [],
    generatedImages: [],
    imageFavorites: [],
    imageProjects: [],
    plans: seedPlans(now),
    orders: [],
    paymentEvents: [],
    safetyEvents: [],
    safetyRules: seedSafetyRules(now),
    safetyAppeals: [],
    adminAuditLogs: [],
    operationalIncidents: [],
    alertNotifications: []
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
    expiresAt: null,
    createdAt: now
  };
}

function seedPlans(now: string): Plan[] {
  return [
    {
      id: "starter",
      name: "入门版",
      description: "适合验证提示词方向、探索风格和完成轻量创作。",
      priceCents: 900,
      currency: "CNY",
      credits: 220,
      validDays: 30,
      status: "ACTIVE",
      sortOrder: 10,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "creator",
      name: "创作者版",
      description: "适合个人创作者稳定生成素材，并支持高清下载。",
      priceCents: 1900,
      currency: "CNY",
      credits: 620,
      validDays: 60,
      status: "ACTIVE",
      sortOrder: 20,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "studio",
      name: "团队版",
      description: "面向小团队、电商运营和持续内容生产的高容量积分包。",
      priceCents: 4900,
      currency: "CNY",
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
      term: "儿童安全风险内容",
      action: "BLOCK" as const,
      status: "ACTIVE" as const,
      createdAt: now,
      updatedAt: now
    },
    {
      id: randomUUID(),
      term: "性暴力内容",
      action: "BLOCK" as const,
      status: "ACTIVE" as const,
      createdAt: now,
      updatedAt: now
    },
    {
      id: randomUUID(),
      term: "恐怖主义内容",
      action: "BLOCK" as const,
      status: "ACTIVE" as const,
      createdAt: now,
      updatedAt: now
    },
    {
      id: randomUUID(),
      term: "政治敏感词汇",
      action: "REVIEW" as const,
      status: "ACTIVE" as const,
      createdAt: now,
      updatedAt: now
    }
  ];
}

function normalizeStoreData(data: Partial<StoreData>): StoreData {
  const now = new Date().toISOString();
  const generationTasks = (data.generationTasks ?? []).map((task) => ({
    ...task,
    referenceImageId: task.referenceImageId ?? null,
    providerCostCents: task.providerCostCents ?? 0
  }));
  const generatedImages = (data.generatedImages ?? []).map((image) => {
    const task = generationTasks.find((item) => item.id === image.taskId);
    return {
      ...image,
      projectId: image.projectId ?? null,
      thumbnailUrl: image.thumbnailUrl ?? image.publicUrl ?? "",
      publicUrl: image.publicUrl ?? "",
      generationMetadata: normalizeGenerationMetadata(image.generationMetadata, task, image)
    };
  });
  return {
    users: data.users ?? [],
    sessions: data.sessions ?? [],
    passwordResetTokens: data.passwordResetTokens ?? [],
    emailVerificationTokens: data.emailVerificationTokens ?? [],
    creditAccounts: data.creditAccounts ?? [],
    creditLedgerEntries: (data.creditLedgerEntries ?? []).map((entry) => ({
      ...entry,
      expiresAt: entry.expiresAt ?? null
    })),
    generationTasks,
    referenceImages: data.referenceImages ?? [],
    generatedImages,
    imageFavorites: data.imageFavorites ?? [],
    imageProjects: (data.imageProjects ?? []).map((project) => ({
      ...project,
      description: project.description ?? "",
      coverImageId: project.coverImageId ?? null,
      archivedAt: project.archivedAt ?? null
    })),
    plans: data.plans ?? seedPlans(now),
    orders: data.orders ?? [],
    paymentEvents: data.paymentEvents ?? [],
    safetyEvents: data.safetyEvents ?? [],
    safetyRules: data.safetyRules ?? seedSafetyRules(now),
    safetyAppeals: data.safetyAppeals ?? [],
    adminAuditLogs: (data.adminAuditLogs ?? []).map((log) => ({
      ...log,
      reason: log.reason ?? null
    })),
    operationalIncidents: (data.operationalIncidents ?? []).map((incident) => ({
      ...incident,
      status: incident.status ?? "OPEN",
      errorCode: incident.errorCode ?? null,
      requestId: incident.requestId ?? null,
      userId: incident.userId ?? null,
      taskId: incident.taskId ?? null,
      orderId: incident.orderId ?? null,
      route: incident.route ?? null,
      resolvedAt: incident.resolvedAt ?? null
    })),
    alertNotifications: data.alertNotifications ?? []
  };
}

function normalizeGenerationMetadata(
  metadata: unknown,
  task: StoreData["generationTasks"][number] | undefined,
  image: Pick<StoreData["generatedImages"][number], "taskId" | "width" | "height" | "createdAt">
): GenerationMetadata {
  if (isGenerationMetadata(metadata)) {
    return metadata;
  }
  if (task) {
    return generationMetadataFromTask(task);
  }
  return {
    taskId: image.taskId,
    prompt: "",
    negativePrompt: null,
    style: "realistic",
    aspectRatio: "1:1",
    quality: "standard",
    quantity: 1,
    modelProvider: "unknown",
    modelName: "unknown",
    width: image.width,
    height: image.height,
    creditCost: 0,
    createdAt: image.createdAt
  };
}

function isGenerationMetadata(value: unknown): value is GenerationMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const metadata = value as Partial<GenerationMetadata>;
  return (
    typeof metadata.taskId === "string" &&
    typeof metadata.prompt === "string" &&
    (typeof metadata.negativePrompt === "string" || metadata.negativePrompt === null) &&
    typeof metadata.style === "string" &&
    typeof metadata.aspectRatio === "string" &&
    typeof metadata.quality === "string" &&
    typeof metadata.quantity === "number" &&
    typeof metadata.modelProvider === "string" &&
    typeof metadata.modelName === "string" &&
    typeof metadata.width === "number" &&
    typeof metadata.height === "number" &&
    typeof metadata.creditCost === "number" &&
    typeof metadata.createdAt === "string"
  );
}

function shouldSeedDemoData(): boolean {
  const value = process.env.IMAGORA_SEED_DEMO_DATA;
  if (value !== undefined) {
    return envFlag(value);
  }
  return process.env.NODE_ENV !== "production";
}

function allowPrismaDevelopmentFallback(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  return !envFlag(process.env.DISABLE_PRISMA_DEV_FALLBACK ?? "false");
}

function isPrismaUnavailableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  const code = "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  return (
    name === "PrismaClientInitializationError" ||
    code === "P1001" ||
    /Can't reach database server|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(message)
  );
}

async function withFileLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireFileLock(`${filePath}.lock`);
  try {
    return await action();
  } finally {
    await release();
  }
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}:${Date.now()}`);
      await handle.close();
      return async () => {
        await unlink(lockPath).catch((error) => {
          if (!isNodeError(error, "ENOENT")) {
            throw error;
          }
        });
      };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
      await removeStaleLock(lockPath);
      await sleep(25);
    }
  }
  throw new Error(`Timed out waiting for store lock: ${lockPath}`);
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const content = await readFile(lockPath, "utf8");
    const timestamp = Number(content.split(":")[1]);
    if (Number.isFinite(timestamp) && Date.now() - timestamp > 30_000) {
      await unlink(lockPath);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

function envFlag(value: string): boolean {
  return !["0", "false", "no", "off", "disabled"].includes(value.toLowerCase());
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveStorePath(configuredPath?: string): string {
  if (!configuredPath) {
    return defaultPath;
  }
  return isAbsolute(configuredPath) ? configuredPath : resolve(workspaceRoot, configuredPath);
}
