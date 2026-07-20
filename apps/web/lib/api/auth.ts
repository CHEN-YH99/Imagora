import { apiFetch } from "./client";
import { ApiRequestError } from "./errors";
import type {
  CaptchaChallenge,
  CaptchaConfig,
  CaptchaSelection,
  CaptchaVerification,
  SafetyAppeal,
  User,
  UserSession
} from "./types";

let currentUserCache: User | null | undefined;
let currentUserPromise: Promise<User | null> | null = null;

export function peekCurrentUser(): User | null | undefined {
  return currentUserCache;
}

export function setCurrentUser(user: User | null): void {
  currentUserCache = user;
  currentUserPromise = null;
}

export async function getCurrentUser(options: { force?: boolean } = {}): Promise<User | null> {
  if (!options.force && currentUserCache !== undefined) {
    return currentUserCache;
  }
  if (!options.force && currentUserPromise) {
    return currentUserPromise;
  }

  currentUserPromise = apiFetch<{ user: User }>("/api/auth/me")
    .then((result) => {
      currentUserCache = result.user;
      return result.user;
    })
    .catch((error) => {
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
        currentUserCache = null;
        return null;
      }
      throw error;
    })
    .finally(() => {
      currentUserPromise = null;
    });
  return currentUserPromise;
}

export async function getCaptchaConfig(): Promise<CaptchaConfig> {
  return apiFetch<CaptchaConfig>("/api/auth/captcha-config");
}

export async function getLoginCaptcha(): Promise<CaptchaChallenge> {
  return apiFetch<CaptchaChallenge>("/api/auth/captcha");
}

export async function verifyLoginCaptcha(
  captchaId: string,
  captchaSelections: CaptchaSelection[]
): Promise<CaptchaVerification> {
  return apiFetch<CaptchaVerification>("/api/auth/captcha/verify", {
    method: "POST",
    body: { captchaId, captchaSelections }
  });
}

export async function login(
  email: string,
  password: string,
  options: { captchaVerificationIds?: string[]; turnstileToken?: string } = {}
): Promise<{ user: User }> {
  const result = await apiFetch<{ user: User }>("/api/auth/login", {
    method: "POST",
    body: {
      email,
      password,
      captchaVerificationIds: options.captchaVerificationIds,
      turnstileToken: options.turnstileToken
    }
  });
  setCurrentUser(result.user);
  return result;
}

export async function register(
  email: string,
  password: string,
  options?: { turnstileToken?: string }
): Promise<{ user: User; emailDelivered: boolean }> {
  const result = await apiFetch<{ user: User; emailDelivered: boolean }>("/api/auth/register", {
    method: "POST",
    body: { email, password, turnstileToken: options?.turnstileToken }
  });
  setCurrentUser(result.user);
  return result;
}

export async function logout(): Promise<void> {
  await apiFetch<{ ok: boolean }>("/api/auth/logout", {
    method: "POST"
  });
  setCurrentUser(null);
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await apiFetch<{ ok: boolean; message: string }>("/api/auth/change-password", {
    method: "POST",
    body: { currentPassword, newPassword }
  });
}

export async function changeEmail(currentPassword: string, newEmail: string): Promise<{ user: User }> {
  const result = await apiFetch<{ user: User }>("/api/auth/change-email", {
    method: "POST",
    body: { currentPassword, newEmail }
  });
  setCurrentUser(result.user);
  return result;
}

export async function getSessions(): Promise<{ sessions: UserSession[] }> {
  return apiFetch<{ sessions: UserSession[] }>("/api/auth/sessions");
}

export async function logoutOtherSessions(): Promise<{ removed: number }> {
  return apiFetch<{ ok: boolean; removed: number }>("/api/auth/logout-others", {
    method: "POST"
  });
}

export async function deleteAccount(currentPassword: string, reason?: string): Promise<void> {
  await apiFetch<{ ok: boolean }>("/api/auth/delete-account", {
    method: "POST",
    body: { currentPassword, ...(reason ? { reason } : {}) }
  });
  setCurrentUser(null);
}

export async function submitSafetyAppeal(safetyEventId: string, reason: string): Promise<{ appeal: SafetyAppeal }> {
  return apiFetch<{ appeal: SafetyAppeal }>("/api/safety-appeals", {
    method: "POST",
    body: { safetyEventId, reason }
  });
}

export async function getSafetyAppeals(): Promise<{ appeals: SafetyAppeal[] }> {
  return apiFetch<{ appeals: SafetyAppeal[] }>("/api/safety-appeals");
}
