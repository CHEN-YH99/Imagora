import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const generatedImagePreviewFiles = [
  "apps/web/app/admin/page.tsx",
  "apps/web/app/favorites/page.tsx",
  "apps/web/app/generate/page.tsx",
  "apps/web/app/history/page.tsx",
  "apps/web/app/images/[imageId]/page.tsx"
];

const generatedImageListPreviewFiles = [
  "apps/web/app/admin/page.tsx",
  "apps/web/app/favorites/page.tsx",
  "apps/web/app/generate/page.tsx",
  "apps/web/app/history/page.tsx"
];

test("generated image preview surfaces use thumbnailUrl instead of publicUrl", async () => {
  for (const file of generatedImagePreviewFiles) {
    const content = await readFile(file, "utf8");
    assert.match(content, /thumbnailUrl/);
    assert.doesNotMatch(content, /src=\{image\.publicUrl\}/);
  }
});

test("generated image list previews are lazy-loaded and async decoded", async () => {
  for (const file of generatedImageListPreviewFiles) {
    const content = await readFile(file, "utf8");
    assert.match(content, /loading="lazy"/);
    assert.match(content, /decoding="async"/);
  }
});

test("generated image previews declare dimensions to reduce layout shift", async () => {
  for (const file of generatedImagePreviewFiles) {
    const content = await readFile(file, "utf8");
    assert.match(content, /width=\{(?:image|selectedDetail\.data\.image)\.width\}/);
    assert.match(content, /height=\{(?:image|selectedDetail\.data\.image)\.height\}/);
  }
});
