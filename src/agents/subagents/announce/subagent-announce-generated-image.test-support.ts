import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { parseMessageWithAttachments } from "../../../gateway/chat-attachments.js";
import { encodePngRgb } from "../../../media/png-encode.js";
import { saveMediaBuffer } from "../../../media/store.js";
import { detectAndLoadPromptImages } from "../../embedded-agent-runner/run/images.js";
import { imageCompletionEvents } from "../../subagent-test-fixtures.test-helpers.js";
import { buildSavedMediaAttachment } from "../../tools/media-generate-result-shared.js";
import type { deliverSubagentAnnouncement } from "./subagent-announce-delivery.js";

type CompletionInput = Pick<
  Parameters<typeof deliverSubagentAnnouncement>[0],
  "sourceTool" | "inputAttachments" | "internalEvents"
>;

export function registerGeneratedImageInspectionTest(
  runCompletion: (params: CompletionInput) => Promise<unknown>,
) {
  const mediaTempDirs = useAutoCleanupTempDirTracker(afterEach);
  it("admits only the delivered generation as image input without widening workspace discovery", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", mediaTempDirs.make("openclaw-generated-inspection-"));
    try {
      // Exercise the managed inbound-file path used for ordinary generated images.
      const side = 900;
      const png = encodePngRgb(randomBytes(side * side * 3), side, side);
      const generated = await saveMediaBuffer(png, "image/png", "tool-image-generation");
      const unrelated = await saveMediaBuffer(png, "image/png", "tool-image-generation");
      const input = await runCompletion({
        sourceTool: "image_generate",
        inputAttachments: [
          { type: "image", mimeType: "image/png", content: png.toString("base64") },
        ],
        internalEvents: imageCompletionEvents({
          mediaUrls: [generated.path],
          attachments: [buildSavedMediaAttachment("image", generated)],
        }),
      });
      if (!input || typeof input !== "object") {
        throw new Error("Expected completion agent input");
      }
      const attachments = Reflect.get(input, "attachments");
      expect(attachments).toEqual([
        expect.objectContaining({ mimeType: "image/png", content: png.toString("base64") }),
      ]);
      const parsed = await parseMessageWithAttachments("Review the generated image", attachments);
      expect(parsed.imageOrder).toEqual(["offloaded"]);
      const prepared = await detectAndLoadPromptImages({
        prompt: `Inspect ${unrelated.path}`,
        workspaceDir: mediaTempDirs.make("openclaw-inspection-workspace-"),
        workspaceOnly: true,
        model: { input: ["text", "image"] },
        existingImages: parsed.images,
        media: parsed.media,
        imageOrder: parsed.imageOrder,
      });
      expect(prepared.images).toHaveLength(1);
      expect(prepared.failedMediaCount).toBe(0);
      expect(prepared.skippedCount).toBe(1);
      expect(input).toMatchObject({
        internalEvents: [{ mediaUrls: undefined, attachments: undefined }],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
}
