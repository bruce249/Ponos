/**
 * The Hono app without a listener, so tests can drive every route with `app.request`.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { config, ready } from "./config";
import type { Db } from "./db";
import { createX402 } from "./oracle/x402";
import { mount } from "./routes";

export function createApp(db: Db, opts: { x402?: boolean } = {}): Hono {
  const app = new Hono();
  app.use("*", secureHeaders({ crossOriginResourcePolicy: false }));
  app.use("/api/*", cors({ origin: config.webOrigin, credentials: true }));
  app.use("/api/*", bodyLimit({ maxSize: 256 * 1024 }));
  if ((opts.x402 ?? true) && ready.x402()) {
    app.use("/x402/*", createX402(db).middleware);
  }
  mount(app, db);
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error("[api]", c.req.method, c.req.path, err instanceof Error ? err.message : err);
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
