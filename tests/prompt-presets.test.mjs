import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

test("prompt presets provide deterministic enhancement without losing user intent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-prompt-presets-"));
  const outfile = join(dir, "promptPresets.mjs");

  try {
    await build({
      entryPoints: ["apps/web/app/generate/promptPresets.ts"],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent"
    });

    const module = await import(pathToFileURL(outfile).href);
    assert.ok(module.promptPresets.length >= 5);

    const productPreset = module.resolvePromptPreset("product_photography");
    assert.equal(productPreset.style, "product_photography");
    assert.equal(module.resolvePromptPreset("missing").id, module.defaultPromptPreset.id);

    const enhanced = module.enhancePrompt("薄荷色透明智能相机", "product_photography");
    assert.match(enhanced, /薄荷色透明智能相机/);
    assert.match(enhanced, /产品摄影/);
    assert.match(enhanced, /商业级灯光/);
    assert.ok(enhanced.length <= module.maxEnhancedPromptLength);

    const posterPrompt = module.enhancePrompt("新品发布会主视觉", "poster");
    assert.match(posterPrompt, /新品发布会主视觉/);
    assert.match(posterPrompt, /海报/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
