import { z } from "zod";

import { resultSchema } from "../schema";

/**
 * Schema for expected labels in the CSV's result_json column. Same as the worker's result,
 * except confidence is optional (hand-made labels rarely have one), plus the worker's rule
 * that no noise means type "" and severity "none" (enforced by its Pydantic model, not by
 * result.schema.json).
 */
export const labelSchema = resultSchema
  .extend({ confidence: resultSchema.shape.confidence.optional() })
  .superRefine((label, ctx) => {
    if (!label.background_noise_present) {
      if (label.background_noise_type !== "") {
        ctx.addIssue({ code: "custom", path: ["background_noise_type"], message: 'must be "" when background_noise_present is false' });
      }
      if (label.background_noise_severity !== "none") {
        ctx.addIssue({ code: "custom", path: ["background_noise_severity"], message: 'must be "none" when background_noise_present is false' });
      }
    }
  });

export type Label = z.infer<typeof labelSchema>;

/** One short line per problem, e.g. "emotional_tone: Invalid option ...". */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}
