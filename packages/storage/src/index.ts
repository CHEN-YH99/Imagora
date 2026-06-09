export interface PutObjectInput {
  key: string;
  body: string;
  mimeType: string;
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
    return {
      key: input.key,
      publicUrl: `data:${input.mimeType};charset=utf-8,${encodeURIComponent(input.body)}`,
      fileSize: Buffer.byteLength(input.body, "utf8")
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

export function createObjectStorage(name = process.env.STORAGE_PROVIDER ?? "inline"): ObjectStorage {
  switch (name) {
    case "inline":
      return new InlineDataUrlStorage();
    default:
      throw new Error(`Unsupported storage provider: ${name}`);
  }
}
