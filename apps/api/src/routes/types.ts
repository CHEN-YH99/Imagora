import type { createStore } from "@imagora/database";
import type { createMailer } from "@imagora/mailer";
import type { createPaymentProvider } from "@imagora/payments";
import type { createSafetyProvider } from "@imagora/safety";
import type { createObjectStorage } from "@imagora/storage";
import type { GeneratedImage, GenerationTask, StoreData, User } from "@imagora/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApiRouteApp = FastifyInstance<any, any, any, any, any>;

export interface ApiRouteContext {
  // Routes are split out while main.ts remains the owner of the shared helper bag.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
  store: ReturnType<typeof createStore>;
  mailer: ReturnType<typeof createMailer>;
  paymentProvider: ReturnType<typeof createPaymentProvider>;
  safetyProvider: ReturnType<typeof createSafetyProvider>;
  storage: ReturnType<typeof createObjectStorage>;
  requireAuth: (request: FastifyRequest) => Promise<{ user: User; data: StoreData }>;
  requireAdmin: (request: FastifyRequest) => Promise<{ user: User; data: StoreData }>;
  taskWithRefund: (data: StoreData, task: GenerationTask) => GenerationTask & { refundedCredits: number };
  mustFindOwnTask: (data: StoreData, userId: string, taskId: string) => GenerationTask;
  mustFindTask: (data: StoreData, taskId: string) => GenerationTask;
  mustFindOwnImage: (data: StoreData, userId: string, imageId: string) => GeneratedImage;
  mustFindImage: (data: StoreData, imageId: string) => GeneratedImage;
  withoutImagePublicUrl: (image: GeneratedImage) => GeneratedImage;
  withFavorite: (data: StoreData, userId: string, image: GeneratedImage) => GeneratedImage & { favorite: boolean };
}
