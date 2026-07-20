import { getActiveProviderMetadata, quoteImageGeneration, resolveProviderModel } from "@imagora/ai-providers";
import { AppError, type AspectRatio, type ModelId, type Quality, type StyleId } from "@imagora/shared";

export interface GenerationRuntime {
  enqueueGenerationTask(taskId: string, userId: string, requestedAt: string): Promise<boolean>;
  quote(input: {
    style: StyleId;
    quality: Quality;
    quantity: number;
    aspectRatio: AspectRatio;
    model?: ModelId;
  }): number;
  resolveGenerationProviderSelection(model?: ModelId): {
    providerMetadata: ReturnType<typeof getActiveProviderMetadata>;
    model: ModelId;
  };
}

interface GenerationRuntimeOptions {
  enqueueTask(input: { id: string; userId: string; createdAt: string }): Promise<{ enqueued: boolean }>;
}

export function createGenerationRuntime(options: GenerationRuntimeOptions): GenerationRuntime {
  function enqueueGenerationTask(taskId: string, userId: string, requestedAt: string): Promise<boolean> {
    return options.enqueueTask({ id: taskId, userId, createdAt: requestedAt }).then((attempt) => attempt.enqueued);
  }

  function quote(input: {
    style: StyleId;
    quality: Quality;
    quantity: number;
    aspectRatio: AspectRatio;
    model?: ModelId;
  }): number {
    const { model } = resolveGenerationProviderSelection(input.model);
    return quoteImageGeneration({
      style: input.style,
      quality: input.quality,
      quantity: input.quantity,
      aspectRatio: input.aspectRatio,
      model
    }).creditCost;
  }

  function resolveGenerationProviderSelection(model?: ModelId): {
    providerMetadata: ReturnType<typeof getActiveProviderMetadata>;
    model: ModelId;
  } {
    const requestedModel = parseGenerationModel(model);
    const providerMetadata = getActiveProviderMetadata();
    const fallbackModel = providerMetadata.modelName;
    try {
      const resolvedModel = resolveProviderModel(requestedModel ?? fallbackModel, providerMetadata.name);
      return {
        providerMetadata: {
          ...providerMetadata,
          modelName: resolvedModel
        },
        model: resolvedModel
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider model is not configured";
      if (
        providerMetadata.name === "mock" &&
        requestedModel &&
        isCompatibleOpenAiRequestForMockProvider(requestedModel)
      ) {
        return {
          providerMetadata: {
            ...providerMetadata,
            modelName: fallbackModel
          },
          model: fallbackModel
        };
      }
      throw new AppError("VALIDATION_ERROR", message, 400, { model: requestedModel });
    }
  }

  return {
    enqueueGenerationTask,
    quote,
    resolveGenerationProviderSelection
  };
}

function parseGenerationModel(model?: ModelId): ModelId | undefined {
  const normalized = model?.trim();
  return normalized ? normalized : undefined;
}

function isCompatibleOpenAiRequestForMockProvider(model: ModelId): boolean {
  try {
    resolveProviderModel(model, "openai");
    return true;
  } catch {
    return false;
  }
}
