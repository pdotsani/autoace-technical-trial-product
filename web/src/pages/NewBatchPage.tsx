import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";

import type { RunSummary, ValidationReport } from "@autoace/shared/api-types";
import { extensionOf, validateBatch } from "@autoace/shared/validation";

import { useApi } from "../api/ApiContext";
import { ApiError, errorMessage } from "../api/client";
import { uploadAll } from "../api/uploads";
import { DownloadButtons } from "../components/DownloadButtons";
import { StatusChip, type ChipTone } from "../components/StatusChip";
import { ErrorState, Loading } from "../components/States";
import { formatBytes } from "../format";
import { filesFromDrop, filesFromInput, mergeStaged, type StagedFile } from "../staging/files";
import { analyzeBlockers, isRunProcessing, SKIP_LABELS, summaryLine } from "../staging/report";

// Same defaults as the API (api/src/config.ts); the API checks again on its side
export const LIMITS = {
  supportedAudio: [".wav", ".mp3", ".ogg", ".m4a", ".flac"],
  maxAudioBytes: 500 * 1024 * 1024,
  maxCsvBytes: 5 * 1024 * 1024,
};

type Phase = "idle" | "creating" | "uploading" | "validating" | "analyzing";

const PHASE_LABELS: Record<Phase, string> = {
  idle: "",
  creating: "Creating the batch…",
  uploading: "Uploading files…",
  validating: "Checking the uploaded batch…",
  analyzing: "Starting the analysis…",
};

export function NewBatchPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns() });
  const previous: RunSummary | null = runs.data?.runs[0] ?? null;

  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [csv, setCsv] = useState<{ file: File; text: string } | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmedDelete, setConfirmedDelete] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<{ title: string; message: string; details?: string[] } | null>(null);
  const busy = phase !== "idle";

  // Read the CSV whenever there is exactly one, so validation can match its rows
  const csvFiles = staged.filter((f) => extensionOf(f.name) === ".csv");
  const onlyCsv = csvFiles.length === 1 ? csvFiles[0]!.file : null;
  useEffect(() => {
    if (!onlyCsv || onlyCsv.size > LIMITS.maxCsvBytes) return;
    let cancelled = false;
    onlyCsv.text().then(
      (text) => !cancelled && setCsv({ file: onlyCsv, text }),
      () => !cancelled && setCsv({ file: onlyCsv, text: "" }),
    );
    return () => {
      cancelled = true;
    };
  }, [onlyCsv]);
  const csvText = onlyCsv && csv?.file === onlyCsv ? csv.text : undefined;
  const csvReady = !onlyCsv || onlyCsv.size > LIMITS.maxCsvBytes || csvText !== undefined;

  const report: ValidationReport | null = useMemo(() => {
    if (staged.length === 0) return null;
    const { expected: _expected, ...rest } = validateBatch(
      { files: staged.map((f) => ({ name: f.name, size: f.file.size })), csvText },
      LIMITS,
    );
    return rest;
  }, [staged, csvText]);

  const blockers = analyzeBlockers({ stagedCount: staged.length, csvCount: csvFiles.length, csvReady, report, previous, confirmedDelete });
  const canAnalyze = blockers.length === 0 && !busy && !runs.isPending && !runs.isError;

  async function add(load: () => Promise<StagedFile[]>) {
    setAdding(true);
    setAddError(null);
    try {
      const files = await load();
      if (files.length === 0) setAddError("No files found (hidden files and __MACOSX folders are skipped).");
      setStaged((current) => mergeStaged(current, files));
      setUploadErrors({});
      setSubmitError(null);
    } catch (err) {
      setAddError(errorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  function remove(name: string) {
    setStaged((current) => current.filter((f) => f.name !== name));
  }

  async function analyze() {
    if (!report || !canAnalyze) return;
    setSubmitError(null);
    setUploadErrors({});
    setProgress({});
    const matched = new Set(report.matched);
    // Only the CSV and the audio it lists: unmatched files would just be skipped by the API
    const toSend = staged.filter((f) => f.name === report.csvName || matched.has(f.name));
    const byName = new Map(toSend.map((f) => [f.name, f.file]));

    try {
      setPhase("creating");
      const created = await api.createRun({ files: toSend.map((f) => ({ name: f.name, size: f.file.size })) });
      await queryClient.invalidateQueries({ queryKey: ["runs"] });

      setPhase("uploading");
      const failures = await uploadAll(api, created.uploads, (name) => byName.get(name), (name, fraction) =>
        setProgress((p) => ({ ...p, [name]: fraction })),
      );
      if (Object.keys(failures).length) {
        setUploadErrors(failures);
        setSubmitError({ title: "Some files did not upload", message: "Check the errors in the file list, then press Analyze to try again." });
        return;
      }

      setPhase("validating");
      const validated = await api.validateRun(created.runId);
      if (!validated.analyzable) {
        setSubmitError({ title: "The uploaded batch can't be analyzed", message: validated.summary, details: validated.blocking });
        return;
      }

      setPhase("analyzing");
      await api.analyzeRun(created.runId);
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      navigate(`/runs/${created.runId}`);
    } catch (err) {
      const details = err instanceof ApiError && err.code === "INVALID_BATCH" ? (err.details as ValidationReport | undefined)?.blocking : undefined;
      const title = err instanceof ApiError && err.code === "BATCH_PROCESSING" ? "Your previous batch is still processing" : "Could not start the batch";
      setSubmitError({ title, message: errorMessage(err), details });
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
    } finally {
      setPhase("idle");
    }
  }

  const blockersId = useId();
  const previousProcessing = previous !== null && isRunProcessing(previous);

  return (
    <section className="stack">
      <h1>New batch</h1>
      <p className="muted">
        Add one CSV with a <code>name</code> column (and optionally <code>result_json</code> labels) plus the audio files it lists.
      </p>

      {runs.isPending && <Loading label="Checking for an existing batch…" />}
      {runs.isError && <ErrorState error={runs.error} title="Could not check for an existing batch" />}
      {previous && (
        <PreviousBatch
          previous={previous}
          processing={previousProcessing}
          confirmed={confirmedDelete}
          onConfirm={setConfirmedDelete}
          disabled={busy}
        />
      )}

      <fieldset className="card" disabled={busy || previousProcessing}>
        <legend>Files</legend>
        <DropZone onDrop={(e) => add(() => filesFromDrop(e.dataTransfer))}>
          <p>Drag a folder, a ZIP or files here, or</p>
          <div className="pickers">
            <FilePicker label="Choose folder" directory onFiles={(files) => add(() => filesFromInput(files))} />
            <FilePicker label="Choose ZIP" accept=".zip,application/zip" onFiles={(files) => add(() => filesFromInput(files))} />
            <FilePicker label="Choose files" multiple accept=".csv,.wav,.mp3,.ogg,.m4a,.flac,.zip" onFiles={(files) => add(() => filesFromInput(files))} />
          </div>
        </DropZone>
        {adding && <Loading label="Reading files…" />}
        {addError && (
          <p className="field-error" role="alert">
            {addError}
          </p>
        )}
      </fieldset>

      {report && (
        <ValidationPanel
          report={report}
          staged={staged}
          csvReady={csvReady}
          progress={progress}
          uploadErrors={uploadErrors}
          busy={busy}
          onRemove={remove}
          onClear={() => setStaged([])}
        />
      )}

      {submitError && (
        <div className="banner banner-error" role="alert">
          <strong>{submitError.title}</strong>
          <p>{submitError.message}</p>
          {submitError.details && submitError.details.length > 0 && (
            <ul>
              {submitError.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!canAnalyze}
          aria-describedby={blockers.length ? blockersId : undefined}
          title={blockers.join(" ") || undefined}
          onClick={analyze}
        >
          {busy ? PHASE_LABELS[phase] : "Analyze"}
        </button>
        {blockers.length > 0 && !busy && (
          <ul id={blockersId} className="blockers">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        {busy && (
          <p className="muted" role="status">
            {PHASE_LABELS[phase]} Keep this page open until the analysis starts.
          </p>
        )}
      </div>
    </section>
  );
}

function PreviousBatch(props: {
  previous: RunSummary;
  processing: boolean;
  confirmed: boolean;
  onConfirm: (value: boolean) => void;
  disabled: boolean;
}) {
  const { previous, processing } = props;
  if (processing) {
    return (
      <div className="banner banner-warning" role="status">
        <strong>Your previous batch is still processing.</strong>
        <p>
          A new batch replaces the previous one, so you can start one when it is complete.{" "}
          <Link to={`/runs/${previous.runId}`}>Watch its progress</Link>.
        </p>
      </div>
    );
  }
  return (
    <div className="banner banner-warning">
      <strong>Starting a new batch permanently deletes your previous results. Download them first.</strong>
      {previous.submitted ? (
        <DownloadButtons runId={previous.runId} complete={previous.complete} />
      ) : (
        <p>Your previous batch was never started, so it has no results to download.</p>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={props.confirmed} disabled={props.disabled} onChange={(e) => props.onConfirm(e.target.checked)} />
        I understand my previous batch and its results will be deleted
      </label>
    </div>
  );
}

function DropZone({ onDrop, children }: { onDrop: (e: DragEvent) => void; children: ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`dropzone${over ? " dropzone-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop(e);
      }}
    >
      {children}
    </div>
  );
}

function FilePicker(props: { label: string; onFiles: (files: File[]) => void; accept?: string; multiple?: boolean; directory?: boolean }) {
  return (
    <label className="button file-picker">
      <input
        type="file"
        className="visually-hidden"
        accept={props.accept}
        multiple={props.multiple || props.directory}
        // webkitdirectory isn't in React's types; set it as a plain attribute
        ref={(el) => {
          if (el && props.directory) el.setAttribute("webkitdirectory", "");
        }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = ""; // picking the same folder again still fires change
          if (files.length) props.onFiles(files);
        }}
      />
      {props.label}
    </label>
  );
}

interface Row {
  name: string;
  size: number | null; // null: listed in the CSV but not staged
  tone: ChipTone;
  status: string;
  reason: string;
  removable: boolean;
}

function ValidationPanel(props: {
  report: ValidationReport;
  staged: StagedFile[];
  csvReady: boolean;
  progress: Record<string, number>;
  uploadErrors: Record<string, string>;
  busy: boolean;
  onRemove: (name: string) => void;
  onClear: () => void;
}) {
  const { report, staged } = props;
  const rows = useMemo(() => tableRows(report, staged), [report, staged]);
  const checked = report.csvName !== null && props.csvReady && report.blocking.every((b) => !b.startsWith("no CSV"));

  return (
    <div className="card stack">
      <div className="page-head">
        <h2>Validation</h2>
        <button type="button" className="link-button" onClick={props.onClear} disabled={props.busy}>
          Remove all
        </button>
      </div>
      <p className="summary" aria-live="polite">
        {checked ? summaryLine(report) : `${staged.length} file${staged.length === 1 ? "" : "s"} staged`}
      </p>
      {report.blocking.length > 0 && (
        <div className="banner banner-error" role="alert">
          <strong>
            {report.blocking.length} blocking error{report.blocking.length === 1 ? "" : "s"}
          </strong>
          <ul>
            {report.blocking.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}
      {report.warnings.length > 0 && (
        <div className="banner banner-warning">
          <strong>Warnings</strong>
          <ul>
            {report.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Staged files">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Size</th>
              <th scope="col">Status</th>
              <th scope="col">Details</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const fraction = props.progress[row.name];
              const uploadError = props.uploadErrors[row.name];
              return (
                <tr key={row.name}>
                  <th scope="row" className="file-name">
                    {row.name}
                  </th>
                  <td>{row.size === null ? "—" : formatBytes(row.size)}</td>
                  <td>
                    {uploadError ? (
                      <StatusChip tone="bad" label="upload failed" />
                    ) : fraction !== undefined ? (
                      <progress max={1} value={fraction} aria-label={`Uploading ${row.name}`}>
                        {Math.round(fraction * 100)}%
                      </progress>
                    ) : (
                      <StatusChip tone={row.tone} label={row.status} />
                    )}
                  </td>
                  <td className="reason">{uploadError ?? row.reason}</td>
                  <td>
                    {row.removable && (
                      <button type="button" className="link-button" disabled={props.busy} onClick={() => props.onRemove(row.name)} aria-label={`Remove ${row.name}`}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The CSV first, then its rows in order (matched or missing), then the other staged files. */
function tableRows(report: ValidationReport, staged: StagedFile[]): Row[] {
  const sizes = new Map(staged.map((f) => [f.name, f.file.size]));
  const skipped = new Map(report.skipped.map((s) => [s.name, s]));
  const rows: Row[] = [];
  const seen = new Set<string>();
  const push = (row: Row) => {
    if (seen.has(row.name)) return;
    seen.add(row.name);
    rows.push(row);
  };

  for (const f of staged) {
    if (extensionOf(f.name) !== ".csv") continue;
    const isManifest = f.name === report.csvName;
    push({ name: f.name, size: f.file.size, tone: isManifest ? "info" : "bad", status: "CSV", reason: isManifest ? "manifest" : "", removable: true });
  }
  for (const name of report.matched) {
    push({ name, size: sizes.get(name) ?? null, tone: "ok", status: "matched", reason: "", removable: true });
  }
  for (const s of report.skipped) {
    if (s.kind === "missing_audio") push({ name: s.name, size: null, tone: "bad", status: SKIP_LABELS[s.kind], reason: s.reason, removable: false });
  }
  for (const f of staged) {
    const s = skipped.get(f.name);
    push({
      name: f.name,
      size: f.file.size,
      tone: s ? (s.kind === "ignored" ? "muted" : "bad") : "info",
      status: s ? SKIP_LABELS[s.kind] : "waiting for CSV",
      reason: s?.reason ?? "",
      removable: true,
    });
  }
  return rows;
}
