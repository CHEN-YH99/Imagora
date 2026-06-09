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
        reasonMessage: `Prompt matched blocked term: ${hit}`,
        provider: this.name
      };
    }
    return {
      status: "PASSED",
      reasonCode: "OK",
      reasonMessage: "Local text check passed",
      provider: this.name
    };
  }

  async checkImage(input: { mimeType: string; bytes: string }): Promise<SafetyResult> {
    if (!input.mimeType.startsWith("image/")) {
      return {
        status: "BLOCKED",
        reasonCode: "UNSUPPORTED_MIME",
        reasonMessage: "Only image content is allowed",
        provider: this.name
      };
    }
    return {
      status: "PASSED",
      reasonCode: "OK",
      reasonMessage: "Local image check passed",
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
