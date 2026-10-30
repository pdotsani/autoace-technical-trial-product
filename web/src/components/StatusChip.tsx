// Status is shown as an icon and a word, never by color alone.

export type ChipTone = "ok" | "bad" | "muted" | "busy" | "info";

const ICONS: Record<ChipTone, string> = { ok: "✓", bad: "✕", muted: "–", busy: "◌", info: "•" };

export function StatusChip({ tone, label }: { tone: ChipTone; label: string }) {
  return (
    <span className={`chip chip-${tone}`}>
      <span aria-hidden="true">{ICONS[tone]}</span> {label}
    </span>
  );
}

export const FILE_STATUS_TONE = { done: "ok", failed: "bad", skipped: "muted", processing: "busy" } as const satisfies Record<string, ChipTone>;
