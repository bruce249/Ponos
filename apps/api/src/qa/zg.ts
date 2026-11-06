/**
 * 0G Private Computer client. Called only when ZG_API_KEY is set.
 * teeVerified is copied from the provider trace. It is never forced to true.
 */
export type ZgTrustMode = "private" | "verified" | "standard";

export type ZgConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  trustMode: ZgTrustMode;
  disableThinking: boolean;
  timeoutMs?: number;
};

export type ZgMessage = { role: "system" | "user" | "assistant"; content: string };

export type ZgResult = {
  text: string;
  requestId: string | null;
  provider: string | null;
  teeVerified: boolean | null;
  model: string;
};

export class ZgError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly requestId: string | null) {
    super(message);
  }
}

export async function zgChat(cfg: ZgConfig, messages: ZgMessage[], opts: { json?: boolean; maxTokens?: number; temperature?: number } = {}): Promise<ZgResult> {
  try {
    return await call(cfg, messages, opts);
  } catch (e) {
    if (opts.json && e instanceof ZgError && e.status === 400 && /response_format|json/i.test(e.message)) {
      return call(cfg, messages, { ...opts, json: false });
    }
    throw e;
  }
}

async function call(cfg: ZgConfig, messages: ZgMessage[], opts: { json?: boolean; maxTokens?: number; temperature?: number }): Promise<ZgResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    verify_tee: true,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 800,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  if (cfg.disableThinking) body.chat_template_kwargs = { enable_thinking: false };

  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
      "X-0G-Provider-Trust-Mode": cfg.trustMode,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 180_000),
  });
  const raw = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ZgError(`0G returned non-JSON (${res.status}): ${raw.slice(0, 200)}`, res.status, null, null);
  }
  const err = data.error as { message?: string; code?: string } | undefined;
  if (!res.ok || err) {
    const trace = (data.x_0g_trace ?? {}) as { request_id?: string };
    throw new ZgError(`0G ${res.status}: ${err?.message ?? "request failed"}`, res.status, err?.code ?? null, (data.request_id as string) ?? trace.request_id ?? null);
  }
  const trace = (data.x_0g_trace ?? {}) as { request_id?: string; provider?: string; tee_verified?: unknown };
  const choice = (data.choices as { message?: { content?: unknown } }[] | undefined)?.[0];
  const content = choice?.message?.content;
  const text = stripThinking(typeof content === "string" ? content : "");
  return {
    text,
    requestId: trace.request_id ?? null,
    provider: trace.provider ?? null,
    teeVerified: typeof trace.tee_verified === "boolean" ? trace.tee_verified : null,
    model: typeof data.model === "string" ? data.model : cfg.model,
  };
}

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
}
