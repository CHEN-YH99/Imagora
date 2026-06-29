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

test("generated image preview surfaces use thumbnailUrl instead of publicUrl", async () => {
  for (const file of generatedImagePreviewFiles) {
    const content = await readFile(file, "utf8");
    assert.match(content, /thumbnailUrl/);
    assert.doesNotMatch(content, /src=\{image\.publicUrl\}/);
  }
});
