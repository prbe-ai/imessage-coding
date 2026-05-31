/**
 * Same-origin BFF client for the dashboard's own route handlers under
 * `/api/*`. Every call uses `credentials: "include"` so the Better Auth
 * session cookie reaches the server-side handler (which resolves the
 * account and scopes the query). Mirrors prbe-dashboard's credentials:
 * "include" rule.
 */

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function parse<T>(resp: Response): Promise<T> {
  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!resp.ok) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : typeof body === "string" && body
          ? body
          : `HTTP ${resp.status}`;
    throw new ApiError(resp.status, detail);
  }
  return body as T;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(path, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    signal,
  });
  return parse<T>(resp);
}

export async function apiPost<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const resp = await fetch(path, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  return parse<T>(resp);
}
