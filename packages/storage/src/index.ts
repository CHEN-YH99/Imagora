import { createHash, createHmac } from "node:crypto";

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

export function createObjectStorage(name = process.env.STORAGE_PROVIDER ?? "inline"): ObjectStorage {
  switch (name) {
    case "inline":
      return new InlineDataUrlStorage();
    case "s3":
    case "r2":
      return new S3CompatibleObjectStorage();
    default:
      throw new Error(`Unsupported storage provider: ${name}`);
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
