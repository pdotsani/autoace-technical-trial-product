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
  // dev = every request is DEV_USER_ID (no auth); jwt = a Supabase access token is required
  AUTH_MODE: z.enum(["dev", "jwt"]).default("dev"),
  DEV_USER_ID: z.string().min(1).default("dev-user"),
  // https://<project>.supabase.co, no trailing slash. Required when AUTH_MODE=jwt.
  SUPABASE_URL: z.url().transform((u) => u.replace(/\/+$/, "")).optional(),
  JWT_AUDIENCE: z.string().min(1).default("authenticated"),
  PUT_URL_EXPIRES: z.coerce.number().int().positive().default(900),
  WORKER_URL_EXPIRES: z.coerce.number().int().positive().default(3600),
  DOWNLOAD_URL_EXPIRES: z.coerce.number().int().positive().default(900),
  MAX_AUDIO_MB: z.coerce.number().positive().default(500),
  MAX_CSV_MB: z.coerce.number().positive().default(5),
  SUPPORTED_AUDIO: extensionList(".wav,.mp3,.ogg,.m4a,.flac"),
  STALE_AFTER_SEC: z.coerce.number().int().positive().default(960),
  AWS_REGION: z.string().min(1), // set by Lambda
}).refine((env) => env.AUTH_MODE !== "jwt" || env.SUPABASE_URL, { path: ["SUPABASE_URL"], message: "required when AUTH_MODE=jwt" });

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
