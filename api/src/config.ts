import { z } from "zod";

const extensionList = (fallback: string) =>
  z
  .string()
  .default(fallback)
  .transform((s) => s.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean))
  .refine((list) => list.length > 0 && list.every((e) => e.startsWith(".")), "comma-separated extensions like .wav,.mp3");

const envSchema = z.object({
  BUCKET: z.string().min(1),
  WORKER_FUNCTION_NAME: z.string().min(1),
  AUTH_MODE: z.string().default("dev"),
  DEV_USER_ID: z.string().min(1).default("dev-user"),
  PUT_URL_EXPIRES: z.coerce.number().int().positive().default(900),
  WORKER_URL_EXPIRES: z.coerce.number().int().positive().default(3600),
  DOWNLOAD_URL_EXPIRES: z.coerce.number().int().positive().default(900),
  MAX_AUDIO_MB: z.coerce.number().positive().default(500),
  MAX_CSV_MB: z.coerce.number().positive().default(5),
  SUPPORTED_AUDIO: extensionList(".wav,.mp3,.ogg,.m4a,.flac"),
  STALE_AFTER_SEC: z.coerce.number().int().positive().default(960),
  AWS_REGION: z.string().min(1), // set by Lambda
});

export type Config = z.infer<typeof envSchema>;

/** Validated once at cold start; a bad value fails the Lambda init with the variable named. */
export const config: Config = (() => {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${problems}`);
  }
  return parsed.data;
})();

export const MB = 1024 * 1024;
