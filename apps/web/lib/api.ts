export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function errorString(body: unknown, text: string, status: number): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const rec = body as Record<string, unknown>;
    if (typeof rec.error === "string" && rec.error.trim()) return rec.error.trim();
    if (typeof rec.message === "string" && rec.message.trim()) return rec.message.trim();
  }
  if (typeof body === "string" && body.trim()) return body.trim();
  const sliced = text.trim().slice(0, 300);
  return sliced || `HTTP ${status}`;
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(path, { ...init, credentials: "same-origin", headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 300) };
  }
  if (!res.ok) throw new ApiError(errorString(body, text, res.status), res.status, body);
  return body as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
