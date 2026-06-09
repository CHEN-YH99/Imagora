export const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:4000";

export type User = {
  id: string;
  email: string;
  nickname: string;
  role: "USER" | "ADMIN";
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
};

export type CreditAccount = {
  userId: string;
  balance: number;
  totalEarned: number;
  totalSpent: number;
};

export type CreditLedgerEntry = {
  id: string;
  type: "GRANT" | "SPEND" | "REFUND" | "EXPIRE" | "ADJUST";
  amount: number;
  balanceAfter: number;
  remark: string;
  createdAt: string;
};

export type Task = {
  id: string;
  prompt: string;
  style: string;
  aspectRatio: string;
  quantity: number;
  quality: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "BLOCKED";
  creditCost: number;
  failureMessage: string | null;
  createdAt: string;
};

export type GeneratedImage = {
  id: string;
  taskId: string;
  publicUrl: string;
  width: number;
  height: number;
  favorite?: boolean;
  createdAt: string;
};

export type Plan = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  credits: number;
  validDays: number | null;
  status: "ACTIVE" | "INACTIVE";
};

export type Order = {
  id: string;
  orderNo: string;
  planId: string;
  amountCents: number;
  currency: string;
  paymentProvider: string;
  status: "PENDING" | "PAID" | "CANCELED" | "REFUNDED" | "CLOSED";
  createdAt: string;
};

export type AdminMetrics = {
  users: number;
  tasks: number;
  images: number;
  paidOrders: number;
  paidRevenueCents: number;
  blockedSafetyEvents: number;
};

export type SafetyRule = {
  id: string;
  term: string;
  action: "BLOCK" | "REVIEW";
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
};

export function getStoredToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem("imagora.token");
}

export function setStoredToken(token: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  if (token) {
    window.localStorage.setItem("imagora.token", token);
  } else {
    window.localStorage.removeItem("imagora.token");
  }
}

export async function apiFetch<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    token?: string | null;
    body?: unknown;
  } = {}
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = (await response.json()) as { data?: T; error?: { message: string } };
  if (!response.ok || !payload.data) {
    throw new Error(payload.error?.message ?? `API request failed: ${response.status}`);
  }
  return payload.data;
}

export async function login(email: string, password: string): Promise<{ token: string; user: User }> {
  return apiFetch<{ token: string; user: User }>("/api/auth/login", {
    method: "POST",
    body: { email, password }
  });
}

export async function register(email: string, password: string, nickname: string): Promise<{ token: string; user: User }> {
  return apiFetch<{ token: string; user: User }>("/api/auth/register", {
    method: "POST",
    body: { email, password, nickname }
  });
}

export async function loginDemo(): Promise<{ token: string; user: User }> {
  return login("demo@imagora.local", "Demo123!");
}

export async function waitForTask(token: string, taskId: string): Promise<{ task: Task; images: GeneratedImage[] }> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await sleep(1000);
    const result = await apiFetch<{ task: Task; images: GeneratedImage[] }>(`/api/generation/tasks/${taskId}`, {
      token
    });
    if (["SUCCEEDED", "FAILED", "BLOCKED", "CANCELED"].includes(result.task.status)) {
      return result;
    }
  }
  throw new Error("Task polling timed out");
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency
  }).format(cents / 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
