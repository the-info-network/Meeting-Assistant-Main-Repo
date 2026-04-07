#!/usr/bin/env node
/**
 * Pick a Redis URL that works from the developer machine (not Railway private network).
 * Railway sets REDIS_URL to redis.railway.internal — use REDIS_PUBLIC_URL when present.
 *
 * Usage: node scripts/resolve-railway-redis-local.mjs /path/to/railway-vars.json
 *        Prints the URL to stdout; exits 1 with stderr message if none suitable.
 */
import { readFileSync } from "fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: resolve-railway-redis-local.mjs <railway-variables.json>");
  process.exit(1);
}

let v;
try {
  v = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error("Failed to read JSON:", e.message);
  process.exit(1);
}

const pub =
  v.REDIS_PUBLIC_URL ||
  v.REDISPUBLICURL ||
  v.redisPublicUrl ||
  "";
const priv = v.REDIS_URL || "";

if (pub && String(pub).trim()) {
  console.log(String(pub).trim());
  process.exit(0);
}

if (priv && !String(priv).includes("railway.internal")) {
  console.log(String(priv).trim());
  process.exit(0);
}

console.error(
  "No Redis URL usable from localhost. Railway exposes internal REDIS_URL only.\n" +
    "Fix: In Railway → Redis service → enable public networking / TCP proxy, then reference\n" +
    "REDIS_PUBLIC_URL on your app service, or copy the public connection string into recall/.env as REDIS_URL.\n" +
    "See: https://docs.railway.com/databases/troubleshooting/enotfound-redis-railway-internal"
);
process.exit(1);
