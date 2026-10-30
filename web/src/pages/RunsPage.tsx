import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "react-router";

import { useApi } from "../api/ApiContext";
import { StatusChip } from "../components/StatusChip";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { formatDate, runStatus } from "../format";

/** The API keeps one batch per user, so with one run this goes straight to it. */
export function RunsPage() {
  const api = useApi();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns() });

  if (runs.isPending) return <Loading label="Loading your batches…" />;
  if (runs.isError) return <ErrorState error={runs.error} title="Could not load your batches" />;

  const list = runs.data.runs;
  if (list.length === 0) {
    return (
      <EmptyState title="No batches yet">
        <p>Upload a CSV and the call recordings it lists to get started.</p>
        <Link to="/new" className="button button-primary">
          New batch
        </Link>
      </EmptyState>
    );
  }
  if (list.length === 1) return <Navigate to={`/runs/${list[0]!.runId}`} replace />;

  return (
    <section>
      <h1>Your batches</h1>
      <ul className="run-list">
        {list.map((run) => {
          const status = runStatus(run);
          return (
            <li key={run.runId} className="card">
              <Link to={`/runs/${run.runId}`}>{formatDate(run.createdAt)}</Link>
              <StatusChip tone={status.tone} label={status.label} />
              {run.validated && <span className="muted">{run.counts.total} files</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
