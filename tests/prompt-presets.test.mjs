import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("generation prompt limits match the API and preserve oversized input", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { maxPromptLength } from "./packages/shared/src/index.ts";
    import { generationInputSchema } from "./apps/api/src/schemas.ts";
    import {
      maxEnhancedPromptLength,
      maxNegativePromptLength,
      validateGenerationPromptLengths
    } from "./apps/web/app/generate/promptPresets.ts";

    assert.equal(maxPromptLength, 7000);
    assert.equal(maxEnhancedPromptLength, maxPromptLength);
    assert.equal(maxNegativePromptLength, 800);
    const validPrompt = "图".repeat(maxPromptLength);
    const validNegativePrompt = "字".repeat(maxNegativePromptLength);
    const input = {
      prompt: validPrompt,
      negativePrompt: validNegativePrompt,
      style: "realistic",
      aspectRatio: "1:1",
      quantity: 1,
      quality: "standard"
    };
    assert.equal(generationInputSchema.safeParse(input).success, true);
    assert.deepEqual(validateGenerationPromptLengths(validPrompt, validNegativePrompt), {
      prompt: null,
      negativePrompt: null
    });

    const oversizedPrompt = validPrompt + "图";
    const oversizedNegativePrompt = validNegativePrompt + "字";
    assert.equal(generationInputSchema.safeParse({ ...input, prompt: oversizedPrompt }).success, false);
    assert.equal(generationInputSchema.safeParse({ ...input, negativePrompt: oversizedNegativePrompt }).success, false);
    assert.deepEqual(validateGenerationPromptLengths(oversizedPrompt, oversizedNegativePrompt), {
      prompt: "提示词最多支持 7000 个字符，当前为 7001 个字符，请精简后再生成。",
      negativePrompt: "负向提示词最多支持 800 个字符，当前为 801 个字符，请精简后再生成。"
    });
    assert.equal(oversizedPrompt.length, 7001);
    assert.equal(oversizedNegativePrompt.length, 801);
    assert.ok(validateGenerationPromptLengths("图".repeat(6999) + "😀", "").prompt);
    assert.ok(validateGenerationPromptLengths(" ".repeat(7001), "").prompt);
  `;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    stdio: "pipe"
  });
});
