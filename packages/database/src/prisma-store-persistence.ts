import { isDeepStrictEqual } from "node:util";
import type { StoreData } from "@imagora/shared";
import { Prisma } from "../generated/client/index.js";

type TransactionClient = Prisma.TransactionClient;

interface EntityDiff<T> {
  removed: T[];
  changed: T[];
}

export function createEmptyStoreData(): StoreData {
  return {
    users: [],
    sessions: [],
    passwordResetTokens: [],
    emailVerificationTokens: [],
    creditAccounts: [],
    creditLedgerEntries: [],
    generationTasks: [],
    referenceImages: [],
    generatedImages: [],
    imageFavorites: [],
    imageProjects: [],
    plans: [],
    orders: [],
    paymentEvents: [],
    safetyEvents: [],
    safetyRules: [],
    safetyAppeals: [],
    adminAuditLogs: [],
    operationalIncidents: [],
    alertNotifications: []
  };
}

export async function persistStoreDiff(tx: TransactionClient, before: StoreData, after: StoreData): Promise<void> {
  const users = entityDiff(before.users, after.users, (record) => record.id);
  const sessions = entityDiff(before.sessions, after.sessions, (record) => record.token);
  const passwordResetTokens = entityDiff(before.passwordResetTokens, after.passwordResetTokens, (record) => record.id);
  const emailVerificationTokens = entityDiff(
    before.emailVerificationTokens,
    after.emailVerificationTokens,
    (record) => record.id
  );
  const creditAccounts = entityDiff(before.creditAccounts, after.creditAccounts, (record) => record.userId);
  const creditLedgerEntries = entityDiff(before.creditLedgerEntries, after.creditLedgerEntries, (record) => record.id);
  const generationTasks = entityDiff(before.generationTasks, after.generationTasks, (record) => record.id);
  const referenceImages = entityDiff(before.referenceImages, after.referenceImages, (record) => record.id);
  const generatedImages = entityDiff(before.generatedImages, after.generatedImages, (record) => record.id);
  const imageFavorites = entityDiff(
    before.imageFavorites,
    after.imageFavorites,
    (record) => `${record.userId}:${record.imageId}`
  );
  const imageProjects = entityDiff(before.imageProjects, after.imageProjects, (record) => record.id);
  const plans = entityDiff(before.plans, after.plans, (record) => record.id);
  const orders = entityDiff(before.orders, after.orders, (record) => record.id);
  const paymentEvents = entityDiff(before.paymentEvents, after.paymentEvents, (record) => record.id);
  const safetyEvents = entityDiff(before.safetyEvents, after.safetyEvents, (record) => record.id);
  const safetyRules = entityDiff(before.safetyRules, after.safetyRules, (record) => record.id);
  const safetyAppeals = entityDiff(before.safetyAppeals, after.safetyAppeals, (record) => record.id);
  const adminAuditLogs = entityDiff(before.adminAuditLogs, after.adminAuditLogs, (record) => record.id);
  const operationalIncidents = entityDiff(
    before.operationalIncidents,
    after.operationalIncidents,
    (record) => record.id
  );
  const alertNotifications = entityDiff(before.alertNotifications, after.alertNotifications, (record) => record.id);

  await deleteRemoved(alertNotifications.removed, (records) =>
    tx.alertNotification.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(operationalIncidents.removed, (records) =>
    tx.operationalIncident.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(adminAuditLogs.removed, (records) =>
    tx.adminAuditLog.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(safetyAppeals.removed, (records) =>
    tx.safetyAppeal.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(safetyRules.removed, (records) =>
    tx.safetyRule.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(safetyEvents.removed, (records) =>
    tx.safetyEvent.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(paymentEvents.removed, (records) =>
    tx.paymentEvent.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(orders.removed, (records) =>
    tx.order.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(imageFavorites.removed, (records) =>
    tx.imageFavorite.deleteMany({
      where: { OR: records.map((record) => ({ userId: record.userId, imageId: record.imageId })) }
    })
  );
  await deleteRemoved(generatedImages.removed, (records) =>
    tx.generatedImage.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(imageProjects.removed, (records) =>
    tx.imageProject.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(generationTasks.removed, (records) =>
    tx.generationTask.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(referenceImages.removed, (records) =>
    tx.referenceImage.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(creditLedgerEntries.removed, (records) =>
    tx.creditLedgerEntry.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(creditAccounts.removed, (records) =>
    tx.userCreditAccount.deleteMany({ where: { userId: { in: records.map((record) => record.userId) } } })
  );
  await deleteRemoved(passwordResetTokens.removed, (records) =>
    tx.passwordResetToken.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(emailVerificationTokens.removed, (records) =>
    tx.emailVerificationToken.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(sessions.removed, (records) =>
    tx.session.deleteMany({ where: { token: { in: records.map((record) => record.token) } } })
  );
  await deleteRemoved(plans.removed, (records) =>
    tx.plan.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );
  await deleteRemoved(users.removed, (records) =>
    tx.user.deleteMany({ where: { id: { in: records.map((record) => record.id) } } })
  );

  await upsertChanged(users.changed, async (user) => {
    const data = {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      role: user.role,
      status: user.status,
      emailVerifiedAt: optionalDate(user.emailVerifiedAt),
      createdAt: toDate(user.createdAt),
      updatedAt: toDate(user.updatedAt),
      lastLoginAt: optionalDate(user.lastLoginAt)
    };
    await tx.user.upsert({ where: { id: user.id }, create: data, update: data });
  });
  await upsertChanged(plans.changed, async (plan) => {
    const data = {
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
    };
    await tx.plan.upsert({ where: { id: plan.id }, create: data, update: data });
  });
  await upsertChanged(sessions.changed, async (session) => {
    const data = {
      token: session.token,
      userId: session.userId,
      createdAt: toDate(session.createdAt),
      expiresAt: toDate(session.expiresAt)
    };
    await tx.session.upsert({ where: { token: session.token }, create: data, update: data });
  });
  await upsertChanged(passwordResetTokens.changed, async (token) => {
    const data = {
      id: token.id,
      userId: token.userId,
      tokenHash: token.tokenHash,
      expiresAt: toDate(token.expiresAt),
      usedAt: optionalDate(token.usedAt),
      createdAt: toDate(token.createdAt)
    };
    await tx.passwordResetToken.upsert({ where: { id: token.id }, create: data, update: data });
  });
  await upsertChanged(emailVerificationTokens.changed, async (token) => {
    const data = {
      id: token.id,
      userId: token.userId,
      tokenHash: token.tokenHash,
      expiresAt: toDate(token.expiresAt),
      usedAt: optionalDate(token.usedAt),
      createdAt: toDate(token.createdAt)
    };
    await tx.emailVerificationToken.upsert({ where: { id: token.id }, create: data, update: data });
  });
  await upsertChanged(creditAccounts.changed, async (account) => {
    const data = {
      userId: account.userId,
      balance: account.balance,
      totalEarned: account.totalEarned,
      totalSpent: account.totalSpent,
      updatedAt: toDate(account.updatedAt)
    };
    await tx.userCreditAccount.upsert({ where: { userId: account.userId }, create: data, update: data });
  });
  await upsertChanged(creditLedgerEntries.changed, async (entry) => {
    const data = {
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
      expiresAt: optionalDate(entry.expiresAt)
    };
    await tx.creditLedgerEntry.upsert({ where: { id: entry.id }, create: data, update: data });
  });
  await upsertChanged(referenceImages.changed, async (image) => {
    const data = {
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
      deletedAt: optionalDate(image.deletedAt)
    };
    await tx.referenceImage.upsert({ where: { id: image.id }, create: data, update: data });
  });
  await upsertChanged(generationTasks.changed, async (task) => {
    const data = {
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
      startedAt: optionalDate(task.startedAt),
      completedAt: optionalDate(task.completedAt),
      createdAt: toDate(task.createdAt),
      updatedAt: toDate(task.updatedAt)
    };
    await tx.generationTask.upsert({ where: { id: task.id }, create: data, update: data });
  });
  await upsertChanged(imageProjects.changed, async (project) => {
    const data = {
      id: project.id,
      userId: project.userId,
      name: project.name,
      description: project.description,
      coverImageId: project.coverImageId,
      createdAt: toDate(project.createdAt),
      updatedAt: toDate(project.updatedAt),
      archivedAt: optionalDate(project.archivedAt)
    };
    await tx.imageProject.upsert({ where: { id: project.id }, create: data, update: data });
  });
  await upsertChanged(generatedImages.changed, async (image) => {
    const data = {
      id: image.id,
      taskId: image.taskId,
      userId: image.userId,
      projectId: image.projectId,
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
      generationMetadata: generationMetadataToJson(image.generationMetadata),
      deletedAt: optionalDate(image.deletedAt),
      createdAt: toDate(image.createdAt)
    };
    await tx.generatedImage.upsert({ where: { id: image.id }, create: data, update: data });
  });
  await upsertChanged(imageFavorites.changed, async (favorite) => {
    const data = {
      userId: favorite.userId,
      imageId: favorite.imageId,
      createdAt: toDate(favorite.createdAt)
    };
    await tx.imageFavorite.upsert({
      where: { userId_imageId: { userId: favorite.userId, imageId: favorite.imageId } },
      create: data,
      update: data
    });
  });
  await upsertChanged(orders.changed, async (order) => {
    const data = {
      id: order.id,
      userId: order.userId,
      planId: order.planId,
      orderNo: order.orderNo,
      amountCents: order.amountCents,
      currency: order.currency,
      paymentProvider: order.paymentProvider,
      paymentIntentId: order.paymentIntentId,
      status: order.status,
      paidAt: optionalDate(order.paidAt),
      createdAt: toDate(order.createdAt),
      updatedAt: toDate(order.updatedAt)
    };
    await tx.order.upsert({ where: { id: order.id }, create: data, update: data });
  });
  await upsertChanged(paymentEvents.changed, async (event) => {
    const data = {
      id: event.id,
      provider: event.provider,
      providerEventId: event.providerEventId,
      orderId: event.orderId,
      eventType: event.eventType,
      payload: event.payload as Prisma.InputJsonValue,
      processedAt: toDate(event.processedAt),
      createdAt: toDate(event.createdAt)
    };
    await tx.paymentEvent.upsert({ where: { id: event.id }, create: data, update: data });
  });
  await upsertChanged(safetyEvents.changed, async (event) => {
    const data = {
      id: event.id,
      userId: event.userId,
      targetType: event.targetType,
      targetId: event.targetId,
      status: event.status,
      reasonCode: event.reasonCode,
      reasonMessage: event.reasonMessage,
      provider: event.provider,
      createdAt: toDate(event.createdAt)
    };
    await tx.safetyEvent.upsert({ where: { id: event.id }, create: data, update: data });
  });
  await upsertChanged(safetyRules.changed, async (rule) => {
    const data = {
      id: rule.id,
      term: rule.term,
      action: rule.action,
      status: rule.status,
      createdAt: toDate(rule.createdAt),
      updatedAt: toDate(rule.updatedAt)
    };
    await tx.safetyRule.upsert({ where: { id: rule.id }, create: data, update: data });
  });
  await upsertChanged(safetyAppeals.changed, async (appeal) => {
    const data = {
      id: appeal.id,
      userId: appeal.userId,
      safetyEventId: appeal.safetyEventId,
      reason: appeal.reason,
      status: appeal.status,
      adminNote: appeal.adminNote ?? null,
      createdAt: toDate(appeal.createdAt),
      resolvedAt: optionalDate(appeal.resolvedAt)
    };
    await tx.safetyAppeal.upsert({ where: { id: appeal.id }, create: data, update: data });
  });
  await upsertChanged(adminAuditLogs.changed, async (log) => {
    const data = {
      id: log.id,
      adminUserId: log.adminUserId,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      reason: log.reason,
      before: nullableJson(log.before),
      after: nullableJson(log.after),
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      createdAt: toDate(log.createdAt)
    };
    await tx.adminAuditLog.upsert({ where: { id: log.id }, create: data, update: data });
  });
  await upsertChanged(operationalIncidents.changed, async (incident) => {
    const data = {
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
      resolvedAt: optionalDate(incident.resolvedAt)
    };
    await tx.operationalIncident.upsert({ where: { id: incident.id }, create: data, update: data });
  });
  await upsertChanged(alertNotifications.changed, async (notification) => {
    const data = {
      id: notification.id,
      alertId: notification.alertId,
      channel: notification.channel,
      status: notification.status,
      severity: notification.severity,
      dedupeKey: notification.dedupeKey,
      message: notification.message,
      createdAt: toDate(notification.createdAt),
      sentAt: toDate(notification.sentAt)
    };
    await tx.alertNotification.upsert({ where: { id: notification.id }, create: data, update: data });
  });
}

function entityDiff<T>(before: T[], after: T[], key: (record: T) => string): EntityDiff<T> {
  const beforeByKey = new Map(before.map((record) => [key(record), record]));
  const afterKeys = new Set(after.map(key));
  return {
    removed: before.filter((record) => !afterKeys.has(key(record))),
    changed: after.filter((record) => {
      const previous = beforeByKey.get(key(record));
      return previous === undefined || !isDeepStrictEqual(previous, record);
    })
  };
}

async function deleteRemoved<T>(records: T[], remove: (records: T[]) => Promise<unknown>): Promise<void> {
  if (records.length > 0) {
    await remove(records);
  }
}

async function upsertChanged<T>(records: T[], upsert: (record: T) => Promise<void>): Promise<void> {
  for (const record of records) {
    await upsert(record);
  }
}

function toDate(value: string): Date {
  return new Date(value);
}

function optionalDate(value: string | null): Date | null {
  return value ? toDate(value) : null;
}

function nullableJson(value: Record<string, unknown> | null): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function generationMetadataToJson(
  metadata: StoreData["generatedImages"][number]["generationMetadata"]
): Prisma.InputJsonObject {
  return {
    taskId: metadata.taskId,
    prompt: metadata.prompt,
    negativePrompt: metadata.negativePrompt,
    style: metadata.style,
    aspectRatio: metadata.aspectRatio,
    quality: metadata.quality,
    quantity: metadata.quantity,
    modelProvider: metadata.modelProvider,
    modelName: metadata.modelName,
    width: metadata.width,
    height: metadata.height,
    creditCost: metadata.creditCost,
    createdAt: metadata.createdAt
  };
}
