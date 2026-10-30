import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";

import type { RunView } from "@autoace/shared/api-types";

import { useApi } from "../api/ApiContext";
import { ApiError } from "../api/client";
import { DownloadButtons } from "../components/DownloadButtons";
import { FILE_STATUS_TONE, StatusChip } from "../components/StatusChip";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { formatDate, RESULT_COLUMNS, resultCell } from "../format";

export const POLL_MS = 3000;

export function RunPage() {
  const { runId = "" } = useParams();
  const api = useApi();
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.getRun(runId),
    // Poll until every file has an outcome; a batch that was never started won't change
    refetchInterval: (q) => (q.state.data && (q.state.data.complete || !q.state.data.submitted) ? false : POLL_MS),
  });

  if (run.isPending) return <Loading label="Loading batch…" />;
  if (run.isError) {
    const err = run.error;
    if (err instanceof ApiError && err.code === "RUN_NOT_FOUND") {
      return (
        <EmptyState title="Batch not found">
          <p>It may have been replaced by a newer batch: each account keeps only its latest batch.</p>
          <Link to="/runs">Go to your results</Link>
        </EmptyState>
      );
    }
    if (err instanceof ApiError && err.code === "NOT_VALIDATED") {
      return (
        <EmptyState title="This batch was never validated">
          <p>Its upload did not finish. Start a new batch to analyze these files.</p>
          <Link to="/new" className="button button-primary">
            New batch
          </Link>
        </EmptyState>
      );
    }
    return <ErrorState error={err} title="Could not load this batch" />;
  }

  return <RunDetails view={run.data} refreshing={run.isFetching} />;
}

function RunDetails({ view, refreshing }: { view: RunView; refreshing: boolean }) {
  const { counts } = view;
  const finished = counts.done + counts.failed + counts.skipped;

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Batch results</h1>
          <p className="muted">
            Started {formatDate(view.createdAt)} · {counts.total} file{counts.total === 1 ? "" : "s"}
            {view.labeled ? " · labeled" : ""}
          </p>
        </div>
        <DownloadButtons runId={view.runId} complete={view.complete} />
      </div>

      {!view.submitted ? (
        <div className="banner banner-warning" role="status">
          This batch was validated but never started, so it has no results.{" "}
          <Link to="/new">Start a new batch</Link>.
        </div>
      ) : (
        <div className="card">
          <div className="progress-row">
            <label htmlFor="run-progress">{view.complete ? "Complete" : "Processing…"}</label>
            <span aria-live="polite">
              {finished} of {counts.total} finished
              {!view.complete && refreshing ? <span className="visually-hidden"> (refreshing)</span> : null}
            </span>
          </div>
          <progress id="run-progress" max={counts.total || 1} value={finished} />
          <dl className="counts">
            <Count label="Done" value={counts.done} />
            <Count label="Failed" value={counts.failed} />
            <Count label="Skipped" value={counts.skipped} />
            <Count label="Processing" value={counts.processing} />
          </dl>
        </div>
      )}

      <div className="table-wrap" tabIndex={0} role="region" aria-label="Files and results">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Status</th>
              <th scope="col">Reason</th>
              {RESULT_COLUMNS.map((c) => (
                <th scope="col" key={c.key}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.files.map((f) => (
              <tr key={f.name}>
                <th scope="row" className="file-name">
                  {f.name}
                  {!f.inCsv && <span className="muted small"> (not in CSV)</span>}
                </th>
                <td>
                  <StatusChip tone={FILE_STATUS_TONE[f.status]} label={f.status === "processing" && !view.submitted ? "not started" : f.status} />
                </td>
                <td className="reason">{f.error ?? ""}</td>
                {RESULT_COLUMNS.map((c) => (
                  <td key={c.key}>{f.status === "done" ? resultCell(f.result, c) : ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {view.labeled && <ExpectedTable files={view.files.filter((f) => f.inCsv)} />}
    </section>
  );
}

/** The labels from the CSV's result_json column, in the same columns as the results. */
function ExpectedTable({ files }: { files: RunView["files"] }) {
  return (
    <section className="stack" aria-labelledby="expected-heading">
      <div>
        <h2 id="expected-heading">Expected</h2>
        <p className="muted">From the result_json column of the uploaded CSV.</p>
      </div>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Expected results">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">File</th>
              {RESULT_COLUMNS.map((c) => (
                <th scope="col" key={c.key}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.name}>
                <th scope="row" className="file-name">
                  {f.name}
                  {!f.expected && <span className="muted small"> (no label)</span>}
                </th>
                {RESULT_COLUMNS.map((c) => (
                  <td key={c.key}>{f.expected ? resultCell(f.expected, c) : ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
