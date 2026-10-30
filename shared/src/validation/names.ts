// File-name rules shared by the API, the frontend and (by contract) the Python worker, which
// rejects the same names in worker/adapters/lambda_handler.py. Keep them in sync.

/** Entries a browser or zip tool adds that are never part of a batch; skipped without a report. */
export function isIgnoredEntry(path: string): boolean {
  const parts = path.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? "";
  return parts.includes("__MACOSX") || base === ".DS_Store" || base.startsWith(".") || base === "";
}

/** Why a name can't be used as an S3 key part, or null when it is fine. Names are never altered. */
export function nameProblem(name: string): string | null {
  if (name === "") return "empty name";
  if (name.includes("/") || name.includes("\\")) return "name must not contain '/' or '\\'";
  if (name.startsWith(".")) return "name must not start with '.'";
  return null;
}

/** Lower-cased extension including the dot, or "" when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}
