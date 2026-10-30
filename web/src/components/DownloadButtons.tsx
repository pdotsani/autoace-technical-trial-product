import { useState } from "react";

import type { OutputFormat } from "@autoace/shared/api-types";

import { useApi } from "../api/ApiContext";
import { errorMessage } from "../api/client";

/** Download CSV / JSON for a run; before it is complete, offers the partial results instead. */
export function DownloadButtons({ runId, complete }: { runId: string; complete: boolean }) {
  const api = useApi();
  const [busy, setBusy] = useState<OutputFormat | "partial" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(format: OutputFormat, partial = false) {
    setBusy(partial ? "partial" : format);
    setError(null);
    try {
      const { url } = await api.getOutput(runId, format, partial);
      const a = document.createElement("a");
      a.href = url;
      a.download = `results_${runId}${partial ? "_partial" : ""}.${format}`;
      document.body.append(a);
      a.click();
      a.remove();
      if (url.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="downloads">
      <button type="button" className="button" disabled={!complete || busy !== null} onClick={() => download("csv")}>
        {busy === "csv" ? "Preparing…" : "Download CSV"}
      </button>
      <button type="button" className="button" disabled={!complete || busy !== null} onClick={() => download("json")}>
        {busy === "json" ? "Preparing…" : "Download JSON"}
      </button>
      {!complete && (
        <button type="button" className="link-button" disabled={busy !== null} onClick={() => download("csv", true)}>
          {busy === "partial" ? "Preparing…" : "Download partial results (CSV)"}
        </button>
      )}
      {error && (
        <p className="field-error" role="alert">
          Download failed: {error}
        </p>
      )}
    </div>
  );
}
