import { createHash } from "node:crypto";
import { AppError, type ReferenceImage } from "@imagora/shared";
import { z } from "zod";
import { referenceUploadSchema } from "./schemas.js";
import { envNumber } from "./runtime.js";

type UploadMimeType = ReferenceImage["mimeType"];

export interface InspectedReferenceUpload {
  contentBase64: string;
  contentHash: string;
  fileSize: number;
  mimeType: UploadMimeType;
  width: number | null;
  height: number | null;
}

export function inspectReferenceUpload(input: z.infer<typeof referenceUploadSchema>): InspectedReferenceUpload {
  const contentBase64 = normalizeBase64(input.contentBase64);
  const bytes = decodeBase64(contentBase64);
  const fileSize = bytes.byteLength;
  const maxBytes = envNumber("UPLOAD_MAX_BYTES", 5 * 1024 * 1024);
  if (fileSize > maxBytes) {
    throw new AppError("VALIDATION_ERROR", "Reference image is too large", 400, { maxBytes, fileSize });
  }

  const mimeType = detectImageMime(bytes);
  if (!mimeType) {
    throw new AppError("VALIDATION_ERROR", "Reference image signature is not supported", 400);
  }
  if (mimeType !== input.mimeType) {
    throw new AppError("VALIDATION_ERROR", "Reference image MIME does not match file signature", 400, {
      declared: input.mimeType,
      detected: mimeType
    });
  }

  const dimensions = readImageDimensions(bytes, mimeType);
  if (!dimensions) {
    throw new AppError("VALIDATION_ERROR", "Reference image dimensions could not be read", 400);
  }
  const maxDimension = envNumber("UPLOAD_MAX_DIMENSION", 8192);
  if (
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width > maxDimension ||
    dimensions.height > maxDimension
  ) {
    throw new AppError("VALIDATION_ERROR", "Reference image dimensions are not allowed", 400, {
      maxDimension,
      width: dimensions.width,
      height: dimensions.height
    });
  }

  return {
    contentBase64,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    fileSize,
    mimeType,
    width: dimensions.width,
    height: dimensions.height
  };
}

export function extensionForMime(mimeType: UploadMimeType): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}

export function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "img";
  }
}

export function contentTypeForStorageKey(key: string): string {
  const extension = key.split(".").pop()?.toLowerCase() ?? "";
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function normalizeBase64(value: string): string {
  const trimmed = value.trim();
  const dataUrl = /^data:([^;]+);base64,(.+)$/i.exec(trimmed);
  return (dataUrl?.[2] ?? trimmed).replace(/\s/g, "");
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new AppError("VALIDATION_ERROR", "Reference image content is not valid base64", 400);
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length) {
    throw new AppError("VALIDATION_ERROR", "Reference image content is empty", 400);
  }
  return bytes;
}

function detectImageMime(bytes: Buffer): UploadMimeType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function readImageDimensions(bytes: Buffer, mimeType: UploadMimeType): { width: number; height: number } | null {
  switch (mimeType) {
    case "image/png":
      return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
    case "image/jpeg":
      return readJpegDimensions(bytes);
    case "image/webp":
      return readWebpDimensions(bytes);
  }
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2) {
      return null;
    }
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb)
    ) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } | null {
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3)
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21];
    const b2 = bytes[22];
    const b3 = bytes[23];
    const b4 = bytes[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff
    };
  }
  return null;
}
