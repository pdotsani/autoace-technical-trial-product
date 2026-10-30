import type { RunSummary, SkipKind, ValidationReport } from "@autoace/shared";

export const SKIP_LABELS: Record<SkipKind, string> = {
  missing_audio: "missing audio",
  unmatched: "unmatched",
  ignored: "ignored",
  invalid_name: "invalid name",
  too_large: "too large",
  empty: "empty",
};

const ORDER: SkipKind[] = ["missing_audio", "unmatched", "ignored", "invalid_name", "too_large", "empty"];

/** e.g. "3 matched · 1 missing audio · 1 unmatched · 1 ignored" */
export function summaryLine(report: ValidationReport): string {
  const counts = new Map<SkipKind, number>();
  for (const s of report.skipped) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const parts = [`${report.matched.length} matched`];
  for (const kind of ORDER) {
    const n = counts.get(kind);
    if (n) parts.push(`${n} ${SKIP_LABELS[kind]}`);
  }
  return parts.join(" · ");
}

// validateBatch's blocking error when the CSV and the audio files have no name in common
const NO_MATCH = "no audio file matches a CSV row";

export interface GateInput {
  stagedCount: number;
  csvCount: number;
  csvReady: boolean; // the CSV's text has been read
  report: ValidationReport | null;
  previous: RunSummary | null; // the user's existing batch, if any
  confirmedDelete: boolean;
}

/** Why Analyze can't run yet, most important first; empty when it can. */
export function analyzeBlockers(input: GateInput): string[] {
  const reasons: string[] = [];
  if (input.previous && isRunProcessing(input.previous)) {
    reasons.push("Your previous batch is still processing. You can start a new one when it is complete.");
  }
  if (input.stagedCount === 0) {
    reasons.push("Add a CSV file and the audio files it lists.");
    return reasons;
  }
  if (input.csvCount === 0) reasons.push("Add one CSV file listing the audio files.");
  else if (input.csvCount > 1) reasons.push(`Remove CSV files until there is exactly one (there are ${input.csvCount}).`);
  else if (!input.csvReady || !input.report) reasons.push("Reading the CSV…");
  else if (input.report.matched.length === 0 && input.report.blocking.every((b) => b === NO_MATCH)) {
    reasons.push("No audio file matches a row of the CSV.");
  } else if (input.report.blocking.length) reasons.push("Fix the blocking errors first.");
  if (input.previous && !isRunProcessing(input.previous) && !input.confirmedDelete) {
    reasons.push("Confirm that your previous results will be deleted.");
  }
  return reasons;
}

/** Submitted and still waiting on results (the API refuses a new batch then: BATCH_PROCESSING). */
export function isRunProcessing(run: RunSummary): boolean {
  return run.submitted && !run.complete;
}
