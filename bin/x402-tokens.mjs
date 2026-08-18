#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

import { loadConfig, createServerFor } from "../dist/server.js";

try {
  const cfg = loadConfig();
  createServerFor(cfg).listen();
  fetch(`${cfg.facilitator}/discovery/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resource: `${cfg.publicUrl}/v1/chat/completions`,
      type: "http",
      x402Version: 1,
      description: "OpenRouter chat completions via x402, paid in yUSDCx. At most OpenRouter's own USD rate, less as you use it more.",
      accepts: [{
        scheme: "exact",
        network: cfg.network,
        asset: cfg.assets[0].mint,
        maxAmountRequired: "1",
        payTo: cfg.payTo,
        resource: `${cfg.publicUrl}/v1/chat/completions`,
      }],
    }),
  }).then(() => console.log("registered in bazaar")).catch(() => console.log("bazaar register failed (non-fatal)"));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
