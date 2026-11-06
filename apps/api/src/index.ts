/**
 * Byline Work API. Boots with a partial environment. Do not leave this process
 * running while another agent is binding the web port; start it only when you mean to.
 */
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { config } from "./config";
import { openDb } from "./db";
import { startLoops } from "./loops";

const db = openDb(config.dbPath);
const app = createApp(db);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`byline-work api listening on ${info.port} (${config.hedera.network})`);
  startLoops(db);
});
