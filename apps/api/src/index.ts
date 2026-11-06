/**
 * Byline Work API. Boots with a partial environment. Do not leave this process
 * running while another agent is binding the web port; start it only when you mean to.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { config, ready } from "./config";
import { openDb } from "./db";
import { startLoops } from "./loops";
import { createX402 } from "./oracle/x402";
import { mount } from "./routes";

const db = openDb(config.dbPath);
const app = new Hono();
app.use("/api/*", cors({ origin: config.webOrigin, credentials: true }));
app.use("/api/*", bodyLimit({ maxSize: 256 * 1024 }));
if (ready.x402()) {
  app.use("/x402/*", createX402(db).middleware);
}
mount(app, db);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`byline-work api listening on ${info.port} (${config.hedera.network})`);
  startLoops(db);
});
