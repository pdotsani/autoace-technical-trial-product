import type { RunSummary, WorkerResult } from "@autoace/shared/api-types";
import type { Result } from "@autoace/shared/schema";

import type { ChipTone } from "./components/StatusChip";

/** "slightly_impaired" -> "Slightly impaired" */
export function enumLabel(value: unknown): string {
  if (typeof value !== "string" || value === "") return "—";
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function yesNo(value: unknown): string {
  return value === true ? "Yes" : value === false ? "No" : "—";
}

export function percent(value: unknown): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "—";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The nine schema fields, in schema order, as table columns. */
export const RESULT_COLUMNS: { key: keyof Result; label: string; format: (v: unknown) => string }[] = [
  { key: "emotional_tone", label: "Tone", format: enumLabel },
  { key: "emotional_intensity", label: "Intensity", format: enumLabel },
  { key: "background_noise_present", label: "Background noise", format: yesNo },
  { key: "background_noise_type", label: "Noise type", format: (v) => (typeof v === "string" && v ? v : "—") },
  { key: "background_noise_severity", label: "Noise severity", format: enumLabel },
  { key: "audio_quality", label: "Audio quality", format: enumLabel },
  { key: "speaker_overlap_present", label: "Speaker overlap", format: yesNo },
  { key: "long_silence_present", label: "Long silence", format: yesNo },
  { key: "confidence", label: "Confidence", format: percent },
];

export function resultCell(result: WorkerResult | undefined, column: (typeof RESULT_COLUMNS)[number]): string {
  return result ? column.format(result[column.key]) : "";
}

export function runStatus(run: RunSummary): { tone: ChipTone; label: string } {
  if (!run.validated) return { tone: "muted", label: "Not validated" };
  if (!run.submitted) return { tone: "muted", label: "Not started" };
  if (!run.complete) return { tone: "busy", label: "Processing" };
  return { tone: "ok", label: "Complete" };
}
