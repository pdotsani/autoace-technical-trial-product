import type { RouteContext, RouteResult } from "./routes";
import { analyzeRun, createRun, getOutput, getRun, listRuns, validateRun } from "./routes";

type Handler = (ctx: RouteContext) => Promise<RouteResult>;

interface Route {
  method: "GET" | "POST";
  pattern: string; // e.g. "/runs/{runId}/validate"
  handler: Handler;
}

export const ROUTES: Route[] = [
  { method: "POST", pattern: "/runs", handler: createRun },
  { method: "GET", pattern: "/runs", handler: listRuns },
  { method: "POST", pattern: "/runs/{runId}/validate", handler: validateRun },
  { method: "POST", pattern: "/runs/{runId}/analyze", handler: analyzeRun },
  { method: "GET", pattern: "/runs/{runId}", handler: getRun },
  { method: "GET", pattern: "/runs/{runId}/output", handler: getOutput },
];

export type Match =
  | { kind: "found"; route: Route; params: Record<string, string> }
  | { kind: "method_not_allowed" }
  | { kind: "not_found" };

/** Match a request path (trailing slash ignored) against ROUTES; {param} matches one segment. */
export function match(method: string, path: string): Match {
  const segments = trimSlashes(path).split("/");
  let pathMatched = false;
  for (const route of ROUTES) {
    const params = matchPattern(trimSlashes(route.pattern).split("/"), segments);
    if (!params) continue;
    if (route.method === method.toUpperCase()) return { kind: "found", route, params };
    pathMatched = true;
  }
  return pathMatched ? { kind: "method_not_allowed" } : { kind: "not_found" };
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function matchPattern(pattern: string[], segments: string[]): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const s = segments[i]!;
    if (p.startsWith("{") && p.endsWith("}")) {
      try {
        params[p.slice(1, -1)] = decodeURIComponent(s);
      } catch {
        return null;
      }
    } else if (p !== s) {
      return null;
    }
  }
  return params;
}
