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

/**
 * 阿里云内容安全 Provider - 骨架占位
 *
 * 使用前需要配置环境变量：
 * - ALIYUN_ACCESS_KEY_ID: 阿里云 Access Key ID
 * - ALIYUN_ACCESS_KEY_SECRET: 阿里云 Access Key Secret
 * - ALIYUN_CONTENT_SAFETY_ENDPOINT: 内容安全 API 端点（默认 green-cip.cn-shanghai.aliyuncs.com）
 * - ALIYUN_CONTENT_SAFETY_REGION: 区域（默认 cn-shanghai）
 */
export class AliyunContentSafetyProvider implements SafetyProvider {
  readonly name = "aliyun";
  private readonly accessKeyId = requiredEnv("ALIYUN_ACCESS_KEY_ID");
  private readonly accessKeySecret = requiredEnv("ALIYUN_ACCESS_KEY_SECRET");
  private readonly endpoint = process.env.ALIYUN_CONTENT_SAFETY_ENDPOINT ?? "green-cip.cn-shanghai.aliyuncs.com";
  private readonly region = process.env.ALIYUN_CONTENT_SAFETY_REGION ?? "cn-shanghai";

  async checkText(_input: { text: string; blockedTerms?: string[] }): Promise<SafetyResult> {
    // TODO: 实现阿里云文本内容检测
    // 参考文档: https://help.aliyun.com/document_detail/53427.html
    throw new Error(
      "AliyunContentSafetyProvider text check not implemented yet. Install @alicloud/green SDK:\n" +
        `  Endpoint: ${this.endpoint}, Region: ${this.region}\n` +
        "  Reference: https://help.aliyun.com/document_detail/53427.html"
    );
  }

  async checkImage(_input: { mimeType: string; bytes: string }): Promise<SafetyResult> {
    // TODO: 实现阿里云图片内容检测
    // 参考文档: https://help.aliyun.com/document_detail/53424.html
    throw new Error(
      "AliyunContentSafetyProvider image check not implemented yet. Install @alicloud/green SDK:\n" +
        `  Endpoint: ${this.endpoint}, Region: ${this.region}\n` +
        "  Reference: https://help.aliyun.com/document_detail/53424.html"
    );
  }
}

/**
 * 腾讯云天御内容安全 Provider - 骨架占位
 *
 * 使用前需要配置环境变量：
 * - TENCENT_SECRET_ID: 腾讯云 SecretId
 * - TENCENT_SECRET_KEY: 腾讯云 SecretKey
 * - TENCENT_CONTENT_SAFETY_REGION: 区域（默认 ap-guangzhou）
 * - TENCENT_CONTENT_SAFETY_ENDPOINT: API 端点（默认 ims.tencentcloudapi.com）
 */
export class TencentContentSafetyProvider implements SafetyProvider {
  readonly name = "tencent";
  private readonly secretId = requiredEnv("TENCENT_SECRET_ID");
  private readonly secretKey = requiredEnv("TENCENT_SECRET_KEY");
  private readonly region = process.env.TENCENT_CONTENT_SAFETY_REGION ?? "ap-guangzhou";
  private readonly endpoint = process.env.TENCENT_CONTENT_SAFETY_ENDPOINT ?? "ims.tencentcloudapi.com";

  async checkText(_input: { text: string; blockedTerms?: string[] }): Promise<SafetyResult> {
    // TODO: 实现腾讯云文本内容安全检测
    // 参考文档: https://cloud.tencent.com/document/product/1124/51860
    throw new Error(
      "TencentContentSafetyProvider text check not implemented yet. Install tencentcloud-sdk-nodejs:\n" +
        `  Region: ${this.region}, Endpoint: ${this.endpoint}\n` +
        "  Reference: https://cloud.tencent.com/document/product/1124/51860"
    );
  }

  async checkImage(_input: { mimeType: string; bytes: string }): Promise<SafetyResult> {
    // TODO: 实现腾讯云图片内容安全检测
    // 参考文档: https://cloud.tencent.com/document/product/1125/53273
    throw new Error(
      "TencentContentSafetyProvider image check not implemented yet. Install tencentcloud-sdk-nodejs:\n" +
        `  Region: ${this.region}, Endpoint: ${this.endpoint}\n` +
        "  Reference: https://cloud.tencent.com/document/product/1125/53273"
    );
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function createSafetyProvider(name = process.env.SAFETY_PROVIDER ?? "local"): SafetyProvider {
  switch (name) {
    case "local":
      return new LocalSafetyProvider();
    case "aliyun":
      return new AliyunContentSafetyProvider();
    case "tencent":
      return new TencentContentSafetyProvider();
    default:
      throw new Error(`Unsupported safety provider: ${name}`);
  }
}
