import { createHash, randomUUID } from "node:crypto";
import { AppError } from "@imagora/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { appendSetCookie, cookieValue, serializeCookie } from "./auth-runtime.js";
import { captchaRequiredRounds } from "./schemas.js";
import { envBool, envNumber } from "./runtime.js";

export interface CaptchaChallenge {
  answerHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface CaptchaVerification {
  expiresAt: string;
  createdAt: string;
}

interface LoginAttempt {
  remaining: number;
  expiresAt: string;
  createdAt: string;
}

export interface CaptchaSelection {
  x: number;
  y: number;
}

export interface CaptchaOption {
  id: string;
  label: string;
  fill: string;
  accent: string;
}

interface CaptchaTile {
  option: CaptchaOption;
  row: number;
  column: number;
}

export const captchaChallenges = new Map<string, CaptchaChallenge>();
export const captchaVerifications = new Map<string, CaptchaVerification>();
export const loginAttempts = new Map<string, LoginAttempt>();

const captchaColumns = 4;
const captchaRows = 3;

export const captchaOptions: CaptchaOption[] = [
  { id: "cow", label: "奶牛", fill: "#f8fafc", accent: "#0f172a" },
  { id: "duck", label: "鸭子", fill: "#fef3c7", accent: "#f59e0b" },
  { id: "panda", label: "熊猫", fill: "#f8fafc", accent: "#111827" },
  { id: "rabbit", label: "兔子", fill: "#ffe4e6", accent: "#fb7185" },
  { id: "fox", label: "狐狸", fill: "#ffedd5", accent: "#f97316" },
  { id: "seal", label: "海豹", fill: "#e0f2fe", accent: "#0284c7" },
  { id: "cat", label: "猫", fill: "#fef9c3", accent: "#ca8a04" },
  { id: "dog", label: "狗", fill: "#f5e8d8", accent: "#92400e" },
  { id: "owl", label: "猫头鹰", fill: "#ede9fe", accent: "#7c3aed" },
  { id: "turtle", label: "乌龟", fill: "#dcfce7", accent: "#16a34a" },
  { id: "sheep", label: "绵羊", fill: "#f8fafc", accent: "#64748b" },
  { id: "squirrel", label: "松鼠", fill: "#fed7aa", accent: "#ea580c" }
];

export function createCaptchaChallenge(): {
  answer: CaptchaSelection[];
  imageSvg: string;
  targetLabel: string;
} {
  const target = captchaOptions[Math.floor(Math.random() * captchaOptions.length)] ?? captchaOptions[0];
  const targetCount = 2 + Math.floor(Math.random() * 3);
  const targetIndexes = pickUniqueIndexes(captchaColumns * captchaRows, targetCount);
  const tiles: CaptchaTile[] = [];
  for (let index = 0; index < captchaColumns * captchaRows; index += 1) {
    const option = targetIndexes.has(index) ? target : randomNonTargetCaptchaOption(target.id);
    tiles.push({
      option,
      row: Math.floor(index / captchaColumns),
      column: index % captchaColumns
    });
  }
  const answer = [...targetIndexes]
    .sort((left, right) => left - right)
    .map((index) => ({
      x: ((index % captchaColumns) + 0.5) / captchaColumns,
      y: (Math.floor(index / captchaColumns) + 0.5) / captchaRows
    }));

  return {
    answer,
    imageSvg: createCaptchaSvg(tiles, target.label),
    targetLabel: target.label
  };
}

function createCaptchaSvg(tiles: CaptchaTile[], targetLabel: string): string {
  const width = 360;
  const height = 260;
  const cardWidth = 74;
  const cardHeight = 62;
  const gap = 10;
  const offsetX = 18;
  const offsetY = 48;
  const tileSvg = tiles
    .map((tile, index) => {
      const x = offsetX + tile.column * (cardWidth + gap);
      const y = offsetY + tile.row * (cardHeight + gap);
      const noise = index % 2 === 0 ? "#dbeafe" : "#ccfbf1";
      return `<g><rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="12" fill="${tile.option.fill}" stroke="#94a3b8" stroke-width="1.5"/>${createCaptchaAnimalSvg(tile.option, x, y)}<circle cx="${x + 10}" cy="${y + 10}" r="2" fill="${noise}"/></g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="请点击图中所有${escapeXml(targetLabel)}"><rect width="${width}" height="${height}" rx="18" fill="#f8fafc"/><rect x="14" y="14" width="332" height="24" rx="12" fill="#0f766e"/><text x="28" y="31" fill="#ffffff" font-family="Arial, sans-serif" font-size="14" font-weight="700">请点击图中所有${escapeXml(targetLabel)}</text><path d="M14 236 C75 214, 134 250, 206 226 S300 214, 346 238" stroke="#99f6e4" stroke-width="3" fill="none" opacity="0.75"/>${tileSvg}</svg>`;
}

function createCaptchaAnimalSvg(option: CaptchaOption, x: number, y: number): string {
  const accent = option.accent;
  const fill = option.fill;
  switch (option.id) {
    case "cow":
      return `<g><ellipse cx="${x + 37}" cy="${y + 35}" rx="24" ry="15" fill="#f8fafc" stroke="${accent}" stroke-width="3"/><path d="M${x + 20} ${y + 22} L${x + 14} ${y + 12} M${x + 54} ${y + 22} L${x + 60} ${y + 12}" stroke="${accent}" stroke-width="3" stroke-linecap="round"/><circle cx="${x + 29}" cy="${y + 32}" r="4" fill="${accent}"/><circle cx="${x + 45}" cy="${y + 32}" r="4" fill="${accent}"/><path d="M${x + 28} ${y + 43} Q${x + 37} ${y + 49}, ${x + 46} ${y + 43}" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round"/></g>`;
    case "duck":
      return `<g><ellipse cx="${x + 37}" cy="${y + 39}" rx="25" ry="14" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 31}" cy="${y + 25}" r="13" fill="${fill}" stroke="${accent}" stroke-width="3"/><path d="M${x + 41} ${y + 26} L${x + 58} ${y + 21} L${x + 48} ${y + 31} Z" fill="#fb923c"/><circle cx="${x + 29}" cy="${y + 23}" r="3" fill="#0f172a"/></g>`;
    case "panda":
      return `<g><circle cx="${x + 25}" cy="${y + 20}" r="9" fill="${accent}"/><circle cx="${x + 49}" cy="${y + 20}" r="9" fill="${accent}"/><circle cx="${x + 37}" cy="${y + 34}" r="23" fill="#f8fafc" stroke="${accent}" stroke-width="3"/><ellipse cx="${x + 29}" cy="${y + 33}" rx="7" ry="9" fill="${accent}"/><ellipse cx="${x + 45}" cy="${y + 33}" rx="7" ry="9" fill="${accent}"/><circle cx="${x + 37}" cy="${y + 42}" r="4" fill="${accent}"/></g>`;
    case "rabbit":
      return `<g><ellipse cx="${x + 29}" cy="${y + 18}" rx="7" ry="17" fill="${fill}" stroke="${accent}" stroke-width="3" transform="rotate(-12 ${x + 29} ${y + 18})"/><ellipse cx="${x + 46}" cy="${y + 18}" rx="7" ry="17" fill="${fill}" stroke="${accent}" stroke-width="3" transform="rotate(12 ${x + 46} ${y + 18})"/><circle cx="${x + 37}" cy="${y + 39}" r="20" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 30}" cy="${y + 36}" r="3" fill="${accent}"/><circle cx="${x + 44}" cy="${y + 36}" r="3" fill="${accent}"/><path d="M${x + 31} ${y + 45} Q${x + 37} ${y + 50}, ${x + 43} ${y + 45}" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round"/></g>`;
    case "fox":
      return `<g><path d="M${x + 16} ${y + 24} L${x + 25} ${y + 10} L${x + 34} ${y + 26} Z" fill="${fill}" stroke="${accent}" stroke-width="3"/><path d="M${x + 58} ${y + 24} L${x + 49} ${y + 10} L${x + 40} ${y + 26} Z" fill="${fill}" stroke="${accent}" stroke-width="3"/><path d="M${x + 15} ${y + 28} Q${x + 37} ${y + 8}, ${x + 59} ${y + 28} Q${x + 51} ${y + 53}, ${x + 37} ${y + 54} Q${x + 23} ${y + 53}, ${x + 15} ${y + 28} Z" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 30}" cy="${y + 34}" r="3" fill="${accent}"/><circle cx="${x + 44}" cy="${y + 34}" r="3" fill="${accent}"/><path d="M${x + 37} ${y + 40} L${x + 31} ${y + 47} L${x + 43} ${y + 47} Z" fill="#ffffff"/></g>`;
    case "cat":
      return `<g><path d="M${x + 19} ${y + 25} L${x + 27} ${y + 11} L${x + 35} ${y + 26} M${x + 55} ${y + 25} L${x + 47} ${y + 11} L${x + 39} ${y + 26}" fill="none" stroke="${accent}" stroke-width="3" stroke-linejoin="round"/><circle cx="${x + 37}" cy="${y + 37}" r="20" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 30}" cy="${y + 34}" r="3" fill="${accent}"/><circle cx="${x + 44}" cy="${y + 34}" r="3" fill="${accent}"/><path d="M${x + 24} ${y + 43} H${x + 14} M${x + 50} ${y + 43} H${x + 60} M${x + 37} ${y + 40} V${y + 43}" stroke="${accent}" stroke-width="2" stroke-linecap="round"/></g>`;
    case "dog":
      return `<g><ellipse cx="${x + 24}" cy="${y + 29}" rx="9" ry="15" fill="${fill}" stroke="${accent}" stroke-width="3" transform="rotate(22 ${x + 24} ${y + 29})"/><ellipse cx="${x + 50}" cy="${y + 29}" rx="9" ry="15" fill="${fill}" stroke="${accent}" stroke-width="3" transform="rotate(-22 ${x + 50} ${y + 29})"/><circle cx="${x + 37}" cy="${y + 38}" r="20" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 31}" cy="${y + 35}" r="3" fill="${accent}"/><circle cx="${x + 43}" cy="${y + 35}" r="3" fill="${accent}"/><ellipse cx="${x + 37}" cy="${y + 44}" rx="7" ry="5" fill="${accent}"/></g>`;
    case "owl":
      return `<g><path d="M${x + 16} ${y + 22} Q${x + 37} ${y + 7}, ${x + 58} ${y + 22} V${y + 44} Q${x + 37} ${y + 60}, ${x + 16} ${y + 44} Z" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 29}" cy="${y + 32}" r="8" fill="#ffffff" stroke="${accent}" stroke-width="3"/><circle cx="${x + 45}" cy="${y + 32}" r="8" fill="#ffffff" stroke="${accent}" stroke-width="3"/><path d="M${x + 37} ${y + 39} L${x + 32} ${y + 47} H${x + 42} Z" fill="#f59e0b"/></g>`;
    case "turtle":
      return `<g><ellipse cx="${x + 37}" cy="${y + 38}" rx="23" ry="17" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 61}" cy="${y + 36}" r="8" fill="${fill}" stroke="${accent}" stroke-width="3"/><path d="M${x + 23} ${y + 32} Q${x + 37} ${y + 22}, ${x + 51} ${y + 32} M${x + 23} ${y + 44} Q${x + 37} ${y + 54}, ${x + 51} ${y + 44}" stroke="${accent}" stroke-width="2" fill="none"/><circle cx="${x + 64}" cy="${y + 34}" r="2" fill="${accent}"/></g>`;
    case "sheep":
      return `<g><circle cx="${x + 24}" cy="${y + 32}" r="10" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 36}" cy="${y + 27}" r="12" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 49}" cy="${y + 33}" r="11" fill="${fill}" stroke="${accent}" stroke-width="3"/><ellipse cx="${x + 38}" cy="${y + 45}" rx="17" ry="11" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 33}" cy="${y + 43}" r="2.5" fill="${accent}"/><circle cx="${x + 43}" cy="${y + 43}" r="2.5" fill="${accent}"/></g>`;
    case "squirrel":
      return `<g><path d="M${x + 51} ${y + 42} C${x + 68} ${y + 28}, ${x + 55} ${y + 8}, ${x + 42} ${y + 20}" fill="none" stroke="${accent}" stroke-width="8" stroke-linecap="round"/><ellipse cx="${x + 35}" cy="${y + 39}" rx="18" ry="16" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 25}" cy="${y + 25}" r="10" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 22}" cy="${y + 23}" r="2.5" fill="${accent}"/></g>`;
    case "seal":
    default:
      return `<g><ellipse cx="${x + 38}" cy="${y + 38}" rx="27" ry="15" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 32}" cy="${y + 28}" r="12" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 28}" cy="${y + 27}" r="3" fill="${accent}"/><path d="M${x + 36} ${y + 32} C${x + 48} ${y + 29}, ${x + 54} ${y + 33}, ${x + 61} ${y + 40}" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round"/><path d="M${x + 17} ${y + 43} Q${x + 8} ${y + 52}, ${x + 24} ${y + 51}" fill="${fill}" stroke="${accent}" stroke-width="3"/></g>`;
  }
}

export function verifyCaptchaChallenge(captchaId: string, captchaSelections: CaptchaSelection[]): void {
  pruneCaptchaChallenges();
  const challenge = captchaChallenges.get(captchaId);
  captchaChallenges.delete(captchaId);
  if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now()) {
    throw new AppError("CAPTCHA_INVALID", "Image verification is invalid or expired", 400);
  }
  const normalizedSelections = normalizeCaptchaSelections(captchaSelections);
  if (normalizedSelections.length !== captchaSelections.length) {
    throw new AppError("CAPTCHA_INVALID", "Image verification is invalid or expired", 400);
  }
  const actualHash = hashCaptchaAnswer(captchaSelections);
  if (actualHash !== challenge.answerHash) {
    throw new AppError("CAPTCHA_INVALID", "Image verification is invalid or expired", 400);
  }
}

export function verifyCaptchaVerifications(verificationIds: string[]): void {
  pruneCaptchaVerifications();
  const uniqueIds = new Set(verificationIds);
  if (uniqueIds.size !== captchaRequiredRounds) {
    throw new AppError("CAPTCHA_INVALID", "Image verification is invalid or expired", 400);
  }
  const verifications = verificationIds.map((verificationId) => ({
    verificationId,
    verification: captchaVerifications.get(verificationId)
  }));
  for (const { verificationId } of verifications) {
    captchaVerifications.delete(verificationId);
  }
  const now = Date.now();
  if (verifications.some(({ verification }) => !verification || new Date(verification.expiresAt).getTime() <= now)) {
    throw new AppError("CAPTCHA_INVALID", "Image verification is invalid or expired", 400);
  }
}

export function hashCaptchaAnswer(answer: CaptchaSelection[]): string {
  return createHash("sha256").update(normalizeCaptchaSelections(answer).join("|")).digest("hex");
}

function normalizeCaptchaSelections(selections: CaptchaSelection[]): string[] {
  return [...new Set(selections.map(captchaSelectionKey))].sort();
}

function captchaSelectionKey(selection: CaptchaSelection): string {
  const column = Math.min(captchaColumns - 1, Math.max(0, Math.floor(selection.x * captchaColumns)));
  const row = Math.min(captchaRows - 1, Math.max(0, Math.floor(selection.y * captchaRows)));
  return `${row}:${column}`;
}

function pickUniqueIndexes(count: number, targetCount: number): Set<number> {
  const indexes = new Set<number>();
  while (indexes.size < targetCount) {
    indexes.add(Math.floor(Math.random() * count));
  }
  return indexes;
}

function randomNonTargetCaptchaOption(targetId: string): CaptchaOption {
  const options = captchaOptions.filter((option) => option.id !== targetId);
  return options[Math.floor(Math.random() * options.length)] ?? captchaOptions[0];
}

export function exposeCaptchaAnswerForTests(): boolean {
  return process.env.NODE_ENV !== "production" && envBool("EXPOSE_CAPTCHA_ANSWER_FOR_TESTS", false);
}

export function pruneCaptchaChallenges(): void {
  const now = Date.now();
  for (const [captchaId, challenge] of captchaChallenges) {
    if (new Date(challenge.expiresAt).getTime() <= now) {
      captchaChallenges.delete(captchaId);
    }
  }
  const maxChallenges = envNumber("CAPTCHA_MAX_CHALLENGES", 5000);
  if (captchaChallenges.size <= maxChallenges) {
    return;
  }
  const overflow = [...captchaChallenges.entries()]
    .sort(([, left], [, right]) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, captchaChallenges.size - maxChallenges);
  for (const [captchaId] of overflow) {
    captchaChallenges.delete(captchaId);
  }
}

export function pruneCaptchaVerifications(): void {
  const now = Date.now();
  for (const [verificationId, verification] of captchaVerifications) {
    if (new Date(verification.expiresAt).getTime() <= now) {
      captchaVerifications.delete(verificationId);
    }
  }
  const maxVerifications = envNumber("CAPTCHA_MAX_VERIFICATIONS", 5000);
  if (captchaVerifications.size <= maxVerifications) {
    return;
  }
  const overflow = [...captchaVerifications.entries()]
    .sort(([, left], [, right]) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, captchaVerifications.size - maxVerifications);
  for (const [verificationId] of overflow) {
    captchaVerifications.delete(verificationId);
  }
}

// 登录尝试令牌名，随会话 cookie 名派生，避免命名冲突。
function loginAttemptCookieName(): string {
  return process.env.LOGIN_ATTEMPT_COOKIE_NAME ?? "imagora_login_attempt";
}

function loginAttemptMaxTries(): number {
  return envNumber("LOGIN_ATTEMPT_MAX_TRIES", 5);
}

function loginAttemptTtlMs(): number {
  return envNumber("LOGIN_ATTEMPT_TTL_SECONDS", 300) * 1000;
}

// 验证码验过后签发一个带额度的登录尝试令牌，允许在有效期内多次尝试密码而无需重做图片验证。
export function issueLoginAttempt(reply: FastifyReply): void {
  pruneLoginAttempts();
  const token = randomUUID();
  const now = Date.now();
  const expiresAtMs = now + loginAttemptTtlMs();
  loginAttempts.set(token, {
    remaining: loginAttemptMaxTries(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    createdAt: new Date(now).toISOString()
  });
  appendSetCookie(
    reply,
    serializeCookie(loginAttemptCookieName(), token, {
      expires: new Date(expiresAtMs),
      httpOnly: true,
      secure: envBool("SESSION_COOKIE_SECURE", process.env.NODE_ENV === "production"),
      sameSite: process.env.SESSION_COOKIE_SAMESITE ?? "Lax",
      path: "/"
    })
  );
}

// 消费一次登录尝试额度：令牌存在、未过期且有剩余额度则扣 1 并返回 true；否则清理并返回 false。
export function consumeLoginAttempt(request: FastifyRequest): boolean {
  pruneLoginAttempts();
  const token = cookieValue(request.headers.cookie, loginAttemptCookieName());
  if (!token) {
    return false;
  }
  const attempt = loginAttempts.get(token);
  if (!attempt) {
    return false;
  }
  if (new Date(attempt.expiresAt).getTime() <= Date.now() || attempt.remaining <= 0) {
    loginAttempts.delete(token);
    return false;
  }
  attempt.remaining -= 1;
  if (attempt.remaining <= 0) {
    // 额度用尽：本次仍放行，但令牌作废，下次必须重新做图片验证。
    loginAttempts.delete(token);
  }
  return true;
}

// 登录成功或需要强制重验时，清掉当前尝试令牌及其 cookie。
export function clearLoginAttempt(request: FastifyRequest, reply: FastifyReply): void {
  const token = cookieValue(request.headers.cookie, loginAttemptCookieName());
  if (token) {
    loginAttempts.delete(token);
  }
  appendSetCookie(
    reply,
    serializeCookie(loginAttemptCookieName(), "", {
      expires: new Date(0),
      httpOnly: true,
      secure: envBool("SESSION_COOKIE_SECURE", process.env.NODE_ENV === "production"),
      sameSite: process.env.SESSION_COOKIE_SAMESITE ?? "Lax",
      path: "/"
    })
  );
}

function pruneLoginAttempts(): void {
  const now = Date.now();
  for (const [token, attempt] of loginAttempts) {
    if (new Date(attempt.expiresAt).getTime() <= now || attempt.remaining <= 0) {
      loginAttempts.delete(token);
    }
  }
  const maxAttempts = envNumber("LOGIN_ATTEMPT_MAX_TOKENS", 5000);
  if (loginAttempts.size <= maxAttempts) {
    return;
  }
  const overflow = [...loginAttempts.entries()]
    .sort(([, left], [, right]) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, loginAttempts.size - maxAttempts);
  for (const [token] of overflow) {
    loginAttempts.delete(token);
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
