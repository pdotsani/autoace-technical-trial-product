import type { ReactNode } from "react";

import { errorMessage } from "../api/client";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="state" role="status">
      <span className="spinner" aria-hidden="true" /> {label}
    </p>
  );
}

export function ErrorState({ error, title = "Something went wrong", children }: { error: unknown; title?: string; children?: ReactNode }) {
  return (
    <div className="banner banner-error" role="alert">
      <strong>{title}</strong>
      <p>{errorMessage(error)}</p>
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
