import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export interface PutObjectInput {
  key: string;
  body: string;
  mimeType: string;
  bodyEncoding?: "utf8" | "base64";
}

export interface PutObjectResult {
  key: string;
  publicUrl: string;
  fileSize: number;
}

export interface ObjectStorage {
  name: string;
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

export class InlineDataUrlStorage implements ObjectStorage {
  readonly name = "inline-data-url";

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const bodyEncoding = input.bodyEncoding ?? "utf8";
    return {
      key: input.key,
      publicUrl:
        bodyEncoding === "base64"
          ? `data:${input.mimeType};base64,${input.body}`
          : `data:${input.mimeType};charset=utf-8,${encodeURIComponent(input.body)}`,
      fileSize: Buffer.byteLength(input.body, bodyEncoding)
    };
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    return `mock-signed://${encodeURIComponent(key)}?expiresAt=${expiresAt}`;
  }

  async deleteObject(_key: string): Promise<void> {
    return;
  }
}

/**
 * 本地磁盘对象存储：图片写入 LOCAL_STORAGE_DIR，数据库只存路径（key），
 * 避免把 1.6MB 图片 base64 塞进 Postgres 字段拖垮整库写入（P2024）。
 *
 * publicUrl 存 `local://<key>`（非 data: 前缀，走 API 的 getSignedUrl 分支）。
 * getSignedUrl 返回带 HMAC 签名与过期时间的 `/api/files/<key>` 相对路径，
 * 复刻 S3 signed URL 的私有 + 过期语义，由 API 侧 /api/files 路由校验后回读文件。
 */
export class FilesystemObjectStorage implements ObjectStorage {
  readonly name = "filesystem";
  private readonly baseDir = resolve(process.env.LOCAL_STORAGE_DIR ?? "./data/generated-files");
  private readonly signingSecret = process.env.LOCAL_STORAGE_SIGNING_SECRET ?? "imagora-local-storage-dev-secret";
  private readonly publicBasePath = (process.env.LOCAL_STORAGE_PUBLIC_PATH ?? "/api/files").replace(/\/$/, "");

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const filePath = this.resolveKeyPath(input.key);
    await mkdir(dirname(filePath), { recursive: true });
    const buffer = Buffer.from(input.body, input.bodyEncoding ?? "utf8");
    await writeFile(filePath, buffer);
    return {
      key: input.key,
      publicUrl: `local://${input.key}`,
      fileSize: buffer.byteLength
    };
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return this.buildSignedUrl(key, expiresInSeconds);
  }

  /**
   * 同步生成签名 URL，供批量场景（列表缩略图）在同步 map 里直接调用，
   * 避免为每张缩略图 await 一次。语义与 getSignedUrl 完全一致。
   */
  buildSignedUrl(key: string, expiresInSeconds: number): string {
    const expires = Math.max(60, Math.min(expiresInSeconds, 60 * 60 * 24 * 7));
    const expiresAt = Date.now() + expires * 1000;
    const signature = this.sign(key, expiresAt);
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    return `${this.publicBasePath}/${encodedKey}?expiresAt=${expiresAt}&signature=${signature}`;
  }

  async deleteObject(key: string): Promise<void> {
    const filePath = this.resolveKeyPath(key);
    await rm(filePath, { force: true });
  }

  /** 供 API /api/files 路由校验签名与过期，返回文件绝对路径（校验失败抛错）。 */
  verifyAndResolve(key: string, expiresAt: number, signature: string): string {
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
      throw new Error("Signed URL has expired");
    }
    const expected = this.sign(key, expiresAt);
    const provided = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
      throw new Error("Signed URL signature is invalid");
    }
    return this.resolveKeyPath(key);
  }

  private sign(key: string, expiresAt: number): string {
    return createHmac("sha256", this.signingSecret).update(`${key}:${expiresAt}`).digest("hex");
  }

  /** 把 key 解析为 baseDir 下的绝对路径，并防止 `../` 越权穿越目录。 */
  private resolveKeyPath(key: string): string {
    const target = resolve(this.baseDir, key);
    if (target !== this.baseDir && !target.startsWith(this.baseDir + sep)) {
      throw new Error(`Illegal storage key escapes base dir: ${key}`);
    }
    return target;
  }
}

export class S3CompatibleObjectStorage implements ObjectStorage {
  readonly name = "s3-compatible";
  private readonly endpoint = requiredEnv("S3_ENDPOINT").replace(/\/$/, "");
  private readonly region = process.env.S3_REGION ?? "auto";
  private readonly bucket = requiredEnv("S3_BUCKET");
  private readonly accessKeyId = requiredEnv("S3_ACCESS_KEY_ID");
  private readonly secretAccessKey = requiredEnv("S3_SECRET_ACCESS_KEY");
  private readonly publicBaseUrl = process.env.S3_PUBLIC_BASE_URL?.replace(/\/$/, "");
  private readonly timeoutMs = envNumber("S3_TIMEOUT_MS", 30_000);

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const body = Buffer.from(input.body, input.bodyEncoding ?? "utf8");
    const url = this.objectUrl(input.key);
    const headers = {
      "content-type": input.mimeType,
      "content-length": String(body.byteLength),
      "x-amz-content-sha256": sha256Hex(body),
      "x-amz-date": amzDate(new Date())
    };
    const response = await fetch(url, {
      method: "PUT",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        ...headers,
        Authorization: this.authorization("PUT", url, headers)
      },
      body
    });
    if (!response.ok) {
      throw new Error(`S3 putObject failed with ${response.status}: ${await response.text()}`);
    }
    return {
      key: input.key,
      publicUrl: this.publicUrl(input.key),
      fileSize: body.byteLength
    };
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const expires = Math.max(60, Math.min(expiresInSeconds, 60 * 60 * 24 * 7));
    const now = new Date();
    const url = new URL(this.objectUrl(key));
    const credentialScope = `${dateStamp(now)}/${this.region}/s3/aws4_request`;
    url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    url.searchParams.set("X-Amz-Credential", `${this.accessKeyId}/${credentialScope}`);
    url.searchParams.set("X-Amz-Date", amzDate(now));
    url.searchParams.set("X-Amz-Expires", String(expires));
    url.searchParams.set("X-Amz-SignedHeaders", "host");
    const canonicalRequest = [
      "GET",
      url.pathname,
      canonicalQuery(url),
      `host:${url.host}\n`,
      "host",
      "UNSIGNED-PAYLOAD"
    ].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate(now), credentialScope, sha256Hex(canonicalRequest)].join("\n");
    const signature = hmacHex(signingKey(this.secretAccessKey, dateStamp(now), this.region), stringToSign);
    url.searchParams.set("X-Amz-Signature", signature);
    return url.toString();
  }

  async deleteObject(key: string): Promise<void> {
    const url = this.objectUrl(key);
    const headers = {
      "x-amz-content-sha256": sha256Hex(""),
      "x-amz-date": amzDate(new Date())
    };
    const response = await fetch(url, {
      method: "DELETE",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        ...headers,
        Authorization: this.authorization("DELETE", url, headers)
      }
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`S3 deleteObject failed with ${response.status}: ${await response.text()}`);
    }
  }

  private objectUrl(key: string): string {
    const safeKey = key.split("/").map(encodeURIComponent).join("/");
    return `${this.endpoint}/${this.bucket}/${safeKey}`;
  }

  private publicUrl(key: string): string {
    if (!this.publicBaseUrl) {
      return this.objectUrl(key);
    }
    return `${this.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  private authorization(method: string, urlValue: string, headers: Record<string, string>): string {
    const now = parseAmzDate(headers["x-amz-date"]);
    const signedHeaders = Object.keys(headers)
      .map((header) => header.toLowerCase())
      .concat("host")
      .sort();
    const headerRecord = new Map<string, string>([
      ...Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value.trim()] as const),
      ["host", new URL(urlValue).host]
    ]);
    const canonicalHeaders = signedHeaders.map((header) => `${header}:${headerRecord.get(header) ?? ""}`).join("\n");
    const canonicalRequest = [
      method,
      new URL(urlValue).pathname,
      "",
      `${canonicalHeaders}\n`,
      signedHeaders.join(";"),
      headers["x-amz-content-sha256"]
    ].join("\n");
    const credentialScope = `${dateStamp(now)}/${this.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", headers["x-amz-date"], credentialScope, sha256Hex(canonicalRequest)].join(
      "\n"
    );
    const signature = hmacHex(signingKey(this.secretAccessKey, dateStamp(now), this.region), stringToSign);
    return `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;
  }
}

/**
 * 预留扩展接口：阿里云 OSS
 *
 * 当前发行路线只交付 inline / s3 / r2。
 * 这个类不会由 createObjectStorage 返回，直接启用前必须先补齐实现与测试。
 */
export class AliyunOssStorage implements ObjectStorage {
  readonly name = "aliyun-oss";
  private readonly accessKeyId = requiredEnv("ALIYUN_OSS_ACCESS_KEY_ID");
  private readonly accessKeySecret = requiredEnv("ALIYUN_OSS_ACCESS_KEY_SECRET");
  private readonly region = requiredEnv("ALIYUN_OSS_REGION");
  private readonly bucket = requiredEnv("ALIYUN_OSS_BUCKET");
  private readonly endpoint = process.env.ALIYUN_OSS_ENDPOINT ?? `https://${this.bucket}.${this.region}.aliyuncs.com`;

  async putObject(_input: PutObjectInput): Promise<PutObjectResult> {
    // TODO: 实现阿里云 OSS 文件上传
    // 参考文档: https://help.aliyun.com/document_detail/111265.html
    throw new Error(
      "AliyunOssStorage not implemented yet. Install ali-oss SDK:\n" +
        `  Region: ${this.region}, Bucket: ${this.bucket}, Endpoint: ${this.endpoint}\n` +
        "  Reference: https://help.aliyun.com/document_detail/111265.html"
    );
  }

  async getSignedUrl(_key: string, _expiresInSeconds: number): Promise<string> {
    // TODO: 实现阿里云 OSS 签名 URL
    // 参考文档: https://help.aliyun.com/document_detail/111350.html
    throw new Error(
      "AliyunOssStorage signed URL not implemented yet.\n" +
        "  Reference: https://help.aliyun.com/document_detail/111350.html"
    );
  }

  async deleteObject(_key: string): Promise<void> {
    // TODO: 实现阿里云 OSS 文件删除
    // 参考文档: https://help.aliyun.com/document_detail/111266.html
    throw new Error(
      "AliyunOssStorage delete not implemented yet.\n" +
        "  Reference: https://help.aliyun.com/document_detail/111266.html"
    );
  }
}

/**
 * 预留扩展接口：腾讯云 COS
 *
 * 当前发行路线只交付 inline / s3 / r2。
 * 这个类不会由 createObjectStorage 返回，直接启用前必须先补齐实现与测试。
 */
export class TencentCosStorage implements ObjectStorage {
  readonly name = "tencent-cos";
  private readonly secretId = requiredEnv("TENCENT_COS_SECRET_ID");
  private readonly secretKey = requiredEnv("TENCENT_COS_SECRET_KEY");
  private readonly region = requiredEnv("TENCENT_COS_REGION");
  private readonly bucket = requiredEnv("TENCENT_COS_BUCKET");

  async putObject(_input: PutObjectInput): Promise<PutObjectResult> {
    // TODO: 实现腾讯云 COS 文件上传
    // 参考文档: https://cloud.tencent.com/document/product/436/64960
    throw new Error(
      "TencentCosStorage not implemented yet. Install cos-nodejs-sdk-v5:\n" +
        `  Region: ${this.region}, Bucket: ${this.bucket}\n` +
        "  Reference: https://cloud.tencent.com/document/product/436/64960"
    );
  }

  async getSignedUrl(_key: string, _expiresInSeconds: number): Promise<string> {
    // TODO: 实现腾讯云 COS 签名 URL
    // 参考文档: https://cloud.tencent.com/document/product/436/64963
    throw new Error(
      "TencentCosStorage signed URL not implemented yet.\n" +
        "  Reference: https://cloud.tencent.com/document/product/436/64963"
    );
  }

  async deleteObject(_key: string): Promise<void> {
    // TODO: 实现腾讯云 COS 文件删除
    // 参考文档: https://cloud.tencent.com/document/product/436/64961
    throw new Error(
      "TencentCosStorage delete not implemented yet.\n" +
        "  Reference: https://cloud.tencent.com/document/product/436/64961"
    );
  }
}

export function createObjectStorage(name = process.env.STORAGE_PROVIDER ?? "inline"): ObjectStorage {
  switch (name) {
    case "inline":
      return new InlineDataUrlStorage();
    case "filesystem":
      return new FilesystemObjectStorage();
    case "s3":
    case "r2":
      return new S3CompatibleObjectStorage();
    default:
      throw new Error(`Unsupported storage provider: ${name}. Implemented providers: inline, filesystem, s3, r2`);
  }
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function dateStamp(date: Date): string {
  return amzDate(date).slice(0, 8);
}

function parseAmzDate(value: string): Date {
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const hour = value.slice(9, 11);
  const minute = value.slice(11, 13);
  const second = value.slice(13, 15);
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
