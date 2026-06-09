import type { SafetyStatus } from "@imagora/shared";

export interface SafetyResult {
  status: SafetyStatus;
  reasonCode: string;
  reasonMessage: string;
  provider: string;
}

export interface SafetyProvider {
  name: string;
  checkText(input: { text: string; blockedTerms?: string[] }): Promise<SafetyResult>;
  checkImage(input: { mimeType: string; bytes: string }): Promise<SafetyResult>;
}

const defaultBlockedTerms = ["child abuse", "sexual violence", "terrorist", "自杀教学", "未成年人色情"];

export class LocalSafetyProvider implements SafetyProvider {
  readonly name = "local-rules";

  async checkText(input: { text: string; blockedTerms?: string[] }): Promise<SafetyResult> {
    const terms = input.blockedTerms?.length ? input.blockedTerms : defaultBlockedTerms;
    const normalized = input.text.toLowerCase();
    const hit = terms.find((term) => normalized.includes(term.toLowerCase()));
    if (hit) {
      return {
        status: "BLOCKED",
        reasonCode: "LOCAL_RULE_HIT",
        reasonMessage: `提示词命中安全词：${hit}`,
        provider: this.name
      };
    }
    return {
      status: "PASSED",
      reasonCode: "OK",
      reasonMessage: "本地文本检查通过",
      provider: this.name
    };
  }

  async checkImage(input: { mimeType: string; bytes: string }): Promise<SafetyResult> {
    if (!input.mimeType.startsWith("image/")) {
      return {
        status: "BLOCKED",
        reasonCode: "UNSUPPORTED_MIME",
        reasonMessage: "仅允许图片内容",
        provider: this.name
      };
    }
    return {
      status: "PASSED",
      reasonCode: "OK",
      reasonMessage: "本地图片检查通过",
      provider: this.name
    };
  }
}

export function createSafetyProvider(name = process.env.SAFETY_PROVIDER ?? "local"): SafetyProvider {
  switch (name) {
    case "local":
      return new LocalSafetyProvider();
    default:
      throw new Error(`Unsupported safety provider: ${name}`);
  }
}
