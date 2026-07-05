import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "../generated/client/index.js";
import type { CreditLedgerEntry, Plan, SafetyAppeal, StoreData, User } from "@imagora/shared";

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
      this.prisma.user.findMany(),
      this.prisma.session.findMany(),
      this.prisma.passwordResetToken.findMany(),
      this.prisma.emailVerificationToken.findMany(),
      this.prisma.userCreditAccount.findMany(),
      this.prisma.creditLedgerEntry.findMany(),
      this.prisma.generationTask.findMany(),
      this.prisma.referenceImage.findMany(),
      this.prisma.generatedImage.findMany(),
      this.prisma.imageFavorite.findMany(),
      this.prisma.plan.findMany(),
      this.prisma.order.findMany(),
      this.prisma.paymentEvent.findMany(),
      this.prisma.safetyEvent.findMany(),
      this.prisma.safetyRule.findMany(),
      this.prisma.safetyAppeal.findMany(),
      this.prisma.adminAuditLog.findMany(),
      this.prisma.operationalIncident.findMany(),
      this.prisma.alertNotification.findMany()
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
      generationTasks: generationTasks.map((task) => ({
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
      })),
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
      generatedImages: generatedImages.map((image) => ({
        id: image.id,
        taskId: image.taskId,
        userId: image.userId,
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
    await this.prisma.$transaction(async (tx) => {
      await tx.alertNotification.deleteMany();
      await tx.operationalIncident.deleteMany();
      await tx.adminAuditLog.deleteMany();
      await tx.safetyAppeal.deleteMany();
      await tx.safetyRule.deleteMany();
      await tx.safetyEvent.deleteMany();
      await tx.paymentEvent.deleteMany();
      await tx.order.deleteMany();
      await tx.imageFavorite.deleteMany();
      await tx.generatedImage.deleteMany();
      await tx.generationTask.deleteMany();
      await tx.referenceImage.deleteMany();
      await tx.creditLedgerEntry.deleteMany();
      await tx.userCreditAccount.deleteMany();
      await tx.passwordResetToken.deleteMany();
      await tx.emailVerificationToken.deleteMany();
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
            emailVerifiedAt: user.emailVerifiedAt ? toDate(user.emailVerifiedAt) : null,
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
      if (data.passwordResetTokens.length) {
        await tx.passwordResetToken.createMany({
          data: data.passwordResetTokens.map((token) => ({
            id: token.id,
            userId: token.userId,
            tokenHash: token.tokenHash,
            expiresAt: toDate(token.expiresAt),
            usedAt: token.usedAt ? toDate(token.usedAt) : null,
            createdAt: toDate(token.createdAt)
          }))
        });
      }
      if (data.emailVerificationTokens.length) {
        await tx.emailVerificationToken.createMany({
          data: data.emailVerificationTokens.map((token) => ({
            id: token.id,
            userId: token.userId,
            tokenHash: token.tokenHash,
            expiresAt: toDate(token.expiresAt),
            usedAt: token.usedAt ? toDate(token.usedAt) : null,
            createdAt: toDate(token.createdAt)
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
            createdAt: toDate(entry.createdAt),
            expiresAt: entry.expiresAt ? toDate(entry.expiresAt) : null
          }))
        });
      }
      if (data.referenceImages.length) {
        await tx.referenceImage.createMany({
          data: data.referenceImages.map((image) => ({
            id: image.id,
            userId: image.userId,
            storageKey: image.storageKey,
            publicUrl: image.publicUrl,
            originalFileName: image.originalFileName,
            mimeType: image.mimeType,
            fileSize: image.fileSize,
            width: image.width,
            height: image.height,
            contentHash: image.contentHash,
            safetyStatus: image.safetyStatus,
            createdAt: toDate(image.createdAt),
            expiresAt: toDate(image.expiresAt),
            deletedAt: image.deletedAt ? toDate(image.deletedAt) : null
          }))
        });
      }
      if (data.generationTasks.length) {
        await tx.generationTask.createMany({
          data: data.generationTasks.map((task) => ({
            id: task.id,
            userId: task.userId,
            clientRequestId: task.clientRequestId,
            referenceImageId: task.referenceImageId,
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
            providerCostCents: task.providerCostCents,
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
            thumbnailUrl: image.thumbnailUrl || null,
            publicUrl: image.publicUrl || null,
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
      if (data.safetyAppeals.length) {
        await tx.safetyAppeal.createMany({
          data: data.safetyAppeals.map((appeal) => ({
            id: appeal.id,
            userId: appeal.userId,
            safetyEventId: appeal.safetyEventId,
            reason: appeal.reason,
            status: appeal.status,
            adminNote: appeal.adminNote ?? null,
            createdAt: toDate(appeal.createdAt),
            resolvedAt: appeal.resolvedAt ? toDate(appeal.resolvedAt) : null
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
            reason: log.reason,
            before: log.before === null ? Prisma.JsonNull : (log.before as Prisma.InputJsonValue),
            after: log.after === null ? Prisma.JsonNull : (log.after as Prisma.InputJsonValue),
            ipAddress: log.ipAddress,
            userAgent: log.userAgent,
            createdAt: toDate(log.createdAt)
          }))
        });
      }
      if (data.operationalIncidents.length) {
        await tx.operationalIncident.createMany({
          data: data.operationalIncidents.map((incident) => ({
            id: incident.id,
            severity: incident.severity,
            area: incident.area,
            status: incident.status,
            message: incident.message,
            errorCode: incident.errorCode,
            requestId: incident.requestId,
            userId: incident.userId,
            taskId: incident.taskId,
            orderId: incident.orderId,
            route: incident.route,
            createdAt: toDate(incident.createdAt),
            updatedAt: toDate(incident.updatedAt),
            resolvedAt: incident.resolvedAt ? toDate(incident.resolvedAt) : null
          }))
        });
      }
      if (data.alertNotifications.length) {
        await tx.alertNotification.createMany({
          data: data.alertNotifications.map((notification) => ({
            id: notification.id,
            alertId: notification.alertId,
            channel: notification.channel,
            status: notification.status,
            severity: notification.severity,
            dedupeKey: notification.dedupeKey,
            message: notification.message,
            createdAt: toDate(notification.createdAt),
            sentAt: toDate(notification.sentAt)
          }))
        });
      }
    });
  }

  async update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    let result: T | undefined;
    const operation = this.updateChain.then(async () => {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(73341001)");
          const data = await this.read();
          result = await mutate(data);
          await this.write(data);
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
    const userCount = await this.prisma.user.count();
    if (userCount === 0) {
      await this.write(createInitialData());
    }
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
    generationTasks: (data.generationTasks ?? []).map((task) => ({
      ...task,
      referenceImageId: task.referenceImageId ?? null,
      providerCostCents: task.providerCostCents ?? 0
    })),
    referenceImages: data.referenceImages ?? [],
    generatedImages: (data.generatedImages ?? []).map((image) => ({
      ...image,
      thumbnailUrl: image.thumbnailUrl ?? image.publicUrl ?? "",
      publicUrl: image.publicUrl ?? ""
    })),
    imageFavorites: data.imageFavorites ?? [],
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

function toDate(value: string): Date {
  return new Date(value);
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
