export const maxEnhancedPromptLength = 1200;

export type PromptPresetId = "realistic" | "product_photography" | "poster" | "illustration" | "anime";

export type PromptPreset = {
  id: PromptPresetId;
  name: string;
  description: string;
  style: PromptPresetId;
  aspectRatio: "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
  quality: "draft" | "standard" | "high";
  negativePrompt: string;
  enhancement: string;
};

export const promptPresets: PromptPreset[] = [
  {
    id: "product_photography",
    name: "产品摄影",
    description: "适合商品主图、材质细节、商业级灯光。",
    style: "product_photography",
    aspectRatio: "1:1",
    quality: "standard",
    negativePrompt: "低质量、模糊、水印、畸变、脏污背景、过曝",
    enhancement: "产品摄影，商业级灯光，清晰材质细节，干净背景，真实反射，适合电商主视觉"
  },
  {
    id: "poster",
    name: "海报设计",
    description: "适合活动主视觉、封面、社媒传播图。",
    style: "poster",
    aspectRatio: "3:4",
    quality: "standard",
    negativePrompt: "低质量、错别字、杂乱排版、水印、过多文字、主体不清",
    enhancement: "海报主视觉，强层级构图，明确视觉焦点，高对比配色，留出标题和文案排版空间"
  },
  {
    id: "realistic",
    name: "写实质感",
    description: "适合真实场景、人物氛围、空间光影。",
    style: "realistic",
    aspectRatio: "16:9",
    quality: "standard",
    negativePrompt: "低质量、模糊、塑料感、过度磨皮、畸变、水印",
    enhancement: "写实影像质感，自然光影，真实镜头语言，细节清晰，色彩克制，高级氛围"
  },
  {
    id: "illustration",
    name: "品牌插画",
    description: "适合概念表达、功能插图、运营素材。",
    style: "illustration",
    aspectRatio: "4:3",
    quality: "standard",
    negativePrompt: "低质量、线条杂乱、脏色、比例失衡、水印",
    enhancement: "品牌插画，干净线条，层次分明，现代配色，适合产品说明和运营物料"
  },
  {
    id: "anime",
    name: "动漫角色",
    description: "适合角色设定、头像、二次元风格探索。",
    style: "anime",
    aspectRatio: "3:4",
    quality: "standard",
    negativePrompt: "低质量、崩坏手部、多余肢体、畸变、模糊、水印",
    enhancement: "动漫角色设定，清晰轮廓，精致五官，干净背景，细腻上色，角色辨识度高"
  }
];

export const defaultPromptPreset = promptPresets[0];

export function resolvePromptPreset(presetId: string | null | undefined): PromptPreset {
  return promptPresets.find((preset) => preset.id === presetId) ?? defaultPromptPreset;
}

export function enhancePrompt(prompt: string, presetId: string): string {
  const normalizedPrompt = prompt.trim();
  const preset = resolvePromptPreset(presetId);
  const basePrompt = normalizedPrompt || "主体明确的视觉创意";
  const enhanced = `${basePrompt}，${preset.enhancement}，构图完整，主体清晰，细节丰富`;
  return enhanced.length > maxEnhancedPromptLength ? enhanced.slice(0, maxEnhancedPromptLength).trim() : enhanced;
}
