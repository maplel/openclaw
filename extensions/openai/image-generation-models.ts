import { OPENAI_DEFAULT_IMAGE_MODEL } from "./default-models.js";

export const OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL = "gpt-image-1.5";
export const OPENAI_IMAGE_25_MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;
export const OPENAI_QUALITIES = ["low", "medium", "high", "auto"] as const;

const OPENAI_IMAGE_26_MODELS = ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"] as const;
export const OPENAI_IMAGE_MODELS = [
  OPENAI_DEFAULT_IMAGE_MODEL,
  ...OPENAI_IMAGE_25_MODELS,
  ...OPENAI_IMAGE_26_MODELS,
  OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL,
  "gpt-image-1",
  "gpt-image-1-mini",
] as const;
const EXTENDED_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;

export function buildImageQualitiesByModel() {
  return Object.fromEntries(
    [...OPENAI_IMAGE_25_MODELS, ...OPENAI_IMAGE_26_MODELS].map((model) => [
      model,
      [...EXTENDED_QUALITIES],
    ]),
  );
}
