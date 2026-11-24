import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { generateImage } from "openclaw/plugin-sdk/image-generation-runtime";
import { expect, it } from "vitest";
import { openAIImageConfig } from "./image-generation-provider.test-support.js";

export function registerOpenAIImageQualityTests({
  provider,
  jsonRequestCall,
  multipartRequestCall,
}: {
  provider: ImageGenerationProvider;
  jsonRequestCall: () => { body: unknown };
  multipartRequestCall: () => { body: unknown };
}) {
  it.each([
    ["low", undefined],
    ["medium", undefined],
    ["high", undefined],
    ["xhigh", undefined],
    ["max", "medium"],
    ["auto", undefined],
    [undefined, undefined],
  ] as const)(
    "preserves GPT Image 2.6 quality %s with complexity %s in generation and edits",
    async (quality, complexity) => {
      const model = "gpt-image-2.6-sunburst";
      const options = {
        cfg: openAIImageConfig({ baseUrl: "https://api.openai.com/v1" }),
        modelOverride: `openai/${model}`,
        quality,
        ...(complexity ? { providerOptions: { openai: { complexity } } } : {}),
      };
      const deps = { getProvider: () => provider, listProviders: () => [provider] };
      const generation = await generateImage({ ...options, prompt: "Draw a blue cup" }, deps);
      const body = jsonRequestCall().body;
      expect(generation.ignoredOverrides).toEqual([]);
      expect(body).toMatchObject({ model });
      if (quality === undefined) {
        expect(body).not.toHaveProperty("quality");
      } else {
        expect(body).toHaveProperty("quality", quality);
      }
      if (complexity) {
        expect(body).toHaveProperty("complexity", complexity);
      } else {
        expect(body).not.toHaveProperty("complexity");
      }

      const edit = await generateImage(
        {
          ...options,
          prompt: "Change the cup to red",
          inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        },
        deps,
      );
      const form = multipartRequestCall().body;
      if (!(form instanceof FormData)) {
        throw new Error("Expected multipart edit");
      }
      expect(edit.ignoredOverrides).toEqual([]);
      expect(form.get("quality")).toBe(quality ?? null);
      expect(form.get("complexity")).toBe(complexity ?? null);
    },
  );
}
