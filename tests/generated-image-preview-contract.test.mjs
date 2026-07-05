import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sharedPreviewFile = "apps/web/components/GeneratedImagePreview.tsx";
const previewConsumerFiles = [
  "apps/web/app/favorites/page.tsx",
  "apps/web/app/generate/page.tsx",
  "apps/web/app/history/page.tsx",
  "apps/web/app/images/[imageId]/page.tsx"
];
const listPreviewConsumerFiles = [
  "apps/web/app/favorites/page.tsx",
  "apps/web/app/generate/page.tsx",
  "apps/web/app/history/page.tsx"
];
const previewWithDetailLinkFiles = ["apps/web/app/favorites/page.tsx", "apps/web/app/history/page.tsx"];

test("shared preview button guards empty image sources with hover CTA and ratio badge", async () => {
  const content = await readFile(sharedPreviewFile, "utf8");

  assert.match(content, /const thumbnailSrc = resolveImageSrc\(image\.thumbnailUrl, image\.publicUrl\);/);
  assert.match(content, /thumbnailSrc \? \(/);
  assert.match(content, /src=\{thumbnailSrc\}/);
  assert.match(content, /loading="lazy"/);
  assert.match(content, /decoding="async"/);
  assert.match(content, /Sparkles/);
  assert.match(content, /查看原图/);
  assert.match(content, /比例 \{formatImageAspectRatio\(image\.width, image\.height\)\}/);
  assert.match(content, /style=\{\{ aspectRatio: `\$\{image\.width\} \/ \$\{image\.height\}` \}\}/);
});

test("shared lightbox renders the current image source in a proportional loading frame", async () => {
  const content = await readFile(sharedPreviewFile, "utf8");

  assert.match(content, /role="dialog"/);
  assert.match(content, /aria-modal="true"/);
  assert.match(
    content,
    /const fallbackSrc = image \? resolveImageSrc\(image\.thumbnailUrl, image\.publicUrl\) : null;/
  );
  assert.match(content, /const \[isImageLoaded, setIsImageLoaded\] = useState\(false\);/);
  assert.match(content, /apiFetch<\{ url: string; expiresAt: string \}>/);
  assert.match(content, /`\/api\/images\/\$\{image\.id\}\/preview-url`/);
  assert.match(content, /setLightboxSrc\(fullSizeSrc\);/);
  assert.match(content, /src=\{lightboxSrc\}/);
  assert.match(content, /onLoad=\{\(\) => setIsImageLoaded\(true\)\}/);
  assert.match(content, /object-contain/);
  assert.match(content, /style=\{lightboxFrameStyle\(image\.width, image\.height\)\}/);
  assert.match(content, /\{image\.width\} × \{image\.height\}/);
  assert.match(content, /比例 \{formatImageAspectRatio\(image\.width, image\.height\)\}/);
});

test("web image elements do not bind potentially empty API URLs directly to src", async () => {
  const unsafeBindings = [
    [sharedPreviewFile, /src=\{image\.(thumbnailUrl|publicUrl)\}/],
    ["apps/web/app/admin/page.tsx", /src=\{(?:image|selectedDetail\.data\.image)\.thumbnailUrl\}/],
    ["apps/web/app/generate/page.tsx", /src=\{referenceImage\.publicUrl\}/]
  ];

  for (const [file, pattern] of unsafeBindings) {
    const content = await readFile(file, "utf8");
    assert.doesNotMatch(content, pattern, `${file} should sanitize image URLs before rendering img src`);
  }
});

test("user-facing pages wire the shared lightbox into generated image surfaces", async () => {
  for (const file of previewConsumerFiles) {
    const content = await readFile(file, "utf8");
    assert.match(content, /GeneratedImageLightbox/);
    assert.match(content, /selectedPreviewImage/);
  }
});

test("gallery surfaces use the shared preview button", async () => {
  for (const file of listPreviewConsumerFiles) {
    const content = await readFile(file, "utf8");
    assert.match(content, /GeneratedImagePreviewButton/);
    assert.match(content, /setSelectedPreviewImage\(image\)/);
  }
});

test("history and favorites keep explicit detail navigation after image click becomes preview", async () => {
  for (const file of previewWithDetailLinkFiles) {
    const content = await readFile(file, "utf8");
    assert.match(content, /详情/);
  }
});

test("image detail page surfaces the real aspect ratio in both preview and metadata", async () => {
  const content = await readFile("apps/web/app/images/[imageId]/page.tsx", "utf8");

  assert.match(content, /GeneratedImagePreviewButton/);
  assert.match(content, /formatImageAspectRatio\(image\.width, image\.height\)/);
  assert.match(content, /实际比例/);
});
