import type { GeneratedImage, Order, PaymentEvent, Plan, SafetyAppeal, SafetyEvent, Task, User } from "../../lib/api";

export type UserDetail = {
  user: User;
  account: { balance: number; totalEarned: number; totalSpent: number } | undefined;
  stats: {
    totalOrders: number;
    paidOrders: number;
    totalTasks: number;
    succeededTasks: number;
    totalImages: number;
  };
  recentOrders: Order[];
  recentTasks: Task[];
};

export type TaskDetail = {
  task: Task;
  user: User;
  images: GeneratedImage[];
};

export type ImageDetail = {
  image: GeneratedImage;
  user: User;
  task: Task;
};

export type OrderDetail = {
  order: Order;
  user: User;
  plan: Plan;
  paymentEvents: PaymentEvent[];
};

export type SelectedDetail =
  | { kind: "user"; data: UserDetail }
  | { kind: "task"; data: TaskDetail }
  | { kind: "image"; data: ImageDetail }
  | { kind: "order"; data: OrderDetail };

export type CreditAdjustmentDraft = {
  amount: string;
  reason: string;
};

export type PlanFormState = {
  name: string;
  description: string;
  priceCents: string;
  currency: string;
  credits: string;
  validDays: string;
  status: Plan["status"];
  sortOrder: string;
};

export type PlanPayload = {
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  credits: number;
  validDays: number | null;
  status: Plan["status"];
  sortOrder: number;
};

export type Notice = {
  tone: "success" | "danger";
  text: string;
};

export type AdminAccessState = "checking" | "granted";

export type AdminOrderQuery = {
  status?: Order["status"];
  userId?: string;
  orderNo?: string;
  createdFrom?: string;
  createdTo?: string;
};

export type ConfirmState =
  | { kind: "reconcile" }
  | { kind: "user-status"; userId: string; userEmail: string; nextStatus: User["status"] }
  | { kind: "credit-adjust"; userId: string; userEmail: string; amount: number; clientRequestId: string }
  | {
      kind: "image-visibility";
      imageId: string;
      imageLabel: string;
      nextVisibility: GeneratedImage["visibility"];
    }
  | { kind: "plan-status"; planId: string; planName: string; nextStatus: Plan["status"] }
  | {
      kind: "order-refund";
      orderId: string;
      orderNo: string;
      amountCents: number;
      currency: string;
      clientRequestId: string;
    }
  | { kind: "plan-create"; plan: PlanPayload }
  | {
      kind: "plan-save";
      planId: string;
      planName: string;
      patch: Pick<PlanPayload, "priceCents" | "credits" | "sortOrder">;
    }
  | { kind: "safety-event"; eventId: string; nextStatus: Exclude<SafetyEvent["status"], "REVIEW_REQUIRED"> }
  | { kind: "safety-appeal"; appealId: string; nextStatus: Exclude<SafetyAppeal["status"], "PENDING"> };

export const LARGE_CREDIT_ADJUST_THRESHOLD = 1000;

export const emptyPlanForm: PlanFormState = {
  name: "",
  description: "",
  priceCents: "900",
  currency: "CNY",
  credits: "220",
  validDays: "30",
  status: "ACTIVE",
  sortOrder: "40"
};

export const orderStatusOptions: Order["status"][] = ["PENDING", "PAID", "CLOSED", "CANCELED", "REFUNDED"];
