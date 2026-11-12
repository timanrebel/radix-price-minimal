import { WorkerEntrypoint } from "cloudflare:workers";
import config from "../tokens.json";
import { XRD } from "./gateway.js";
export { GatewayCoordinator } from "./coordinator.js";

const BODY_LIMIT = 256 * 1024;
const DAY = 86_400;

class ApiError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

function coordinator(env) {
  return env.GATEWAY_COORDINATOR.getByName("mainnet");
}

export class CachedPrices extends WorkerEntrypoint {
  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);
    if (request.method === "GET" && pathname === "/latest") {
      const { results } = await this.env.DB.prepare("SELECT resource_address, usd_price, last_updated_at FROM latest").all();
      return json(results, 200, results.length ? Number(this.env.PRICE_CACHE_SECS ?? 15) : 0);
    }
    if (request.method === "GET" && pathname === "/lsus") {
      const addresses = searchParams.getAll("address");
      if (addresses.length > 20 || !addresses.every(isLsuCandidate)) {
        return json({ detail: "Invalid LSU batch" }, 400);
      }
      const { values, maxAge } = await coordinator(this.env).lsus(addresses);
      return json(values, 200, maxAge);
    }
    return json({ detail: "Not Found" }, 404);
  }
}

async function readBody(request) {
  if (Number(request.headers.get("Content-Length")) > BODY_LIMIT) {
    await request.body?.cancel();
    throw new ApiError(413, "body too large");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let data = "";
  let bytes = 0;
  let parsed;
  try {
    for await (const chunk of request.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > BODY_LIMIT) throw new ApiError(413, "body too large");
      data += decoder.decode(chunk, { stream: true });
    }
    data += decoder.decode();
    parsed = JSON.parse(data || "null", (key, value, context) => {
      // Python distinguishes integer JSON literals from floats, even when the value is integral.
      if (key === "timestamp" && Number.isInteger(value) && /[.eE]/.test(context?.source ?? "")) {
        return NaN;
      }
      return value;
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "invalid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(422, "body must be a JSON object");
  }
  return parsed;
}

function addressList(body, key, env) {
  const value = body[key];
  const max = Number(env.MAX_ADDRESSES ?? 500);
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every(address => typeof address === "string")) {
    throw new ApiError(422, `${key} must be a list of strings`);
  }
  if (value.length > max) throw new ApiError(422, `too many ${key} (max ${max})`);
  return [...new Set(value)];
}

function isLsuCandidate(address) {
  return /^resource_[a-zA-Z0-9_]{1,120}$/.test(address);
}

async function cachedJson(ctx, url) {
  const response = await ctx.exports.CachedPrices.fetch(new Request(url));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Cached price lookup failed: HTTP ${response.status}`);
  }
  return response.json();
}

async function latestPrices(ctx) {
  const prices = await cachedJson(ctx, "https://internal/latest");
  return new Map(prices.map(price => [price.resource_address, price]));
}

async function lsuPrices(ctx, lsus, xrdPrice) {
  const values = new Map();
  const addresses = lsus.filter(isLsuCandidate).sort();
  for (let start = 0; start < addresses.length; start += 20) {
    const url = new URL("https://internal/lsus");
    for (const address of addresses.slice(start, start + 20)) url.searchParams.append("address", address);
    try {
      for (const [address, value] of await cachedJson(ctx, url)) values.set(address, value);
    } catch (error) {
      console.warn("LSU batch lookup failed", error.message);
    }
  }
  return lsus.filter(address => values.has(address)).map(address => ({
    resource_address: address,
    xrd_redemption_value: values.get(address),
    usd_price: xrdPrice * values.get(address),
  }));
}

async function currentPrices(body, env, ctx) {
  const { currency } = body;
  if (typeof currency !== "string") throw new ApiError(422, "currency is required");
  if (currency.toUpperCase() !== "USD") {
    throw new ApiError(400, `Currency: ${currency} not supported. Supported currencies: USD`);
  }
  const tokens = addressList(body, "tokens", env);
  const lsus = addressList(body, "lsus", env);
  if (!tokens.length && !lsus.length) return { tokens: [], lsus: [] };
  const latest = await latestPrices(ctx);
  const xrd = latest.get(XRD);
  return {
    tokens: tokens.filter(address => latest.has(address)).map(address => latest.get(address)),
    lsus: xrd && lsus.length ? await lsuPrices(ctx, lsus, xrd.usd_price) : [],
  };
}

async function historicalPrices(request, body, env) {
  if (!env.API_KEY || request.headers.get("x-api-key") !== env.API_KEY) {
    throw new ApiError(401, "Invalid or missing API Key");
  }
  const tokens = addressList(body, "tokens", env);
  const { timestamp } = body;
  if (!tokens.length) throw new ApiError(400, "Token list must be provided.");
  if (!Number.isInteger(timestamp)) throw new ApiError(400, "Timestamp must be an integer (unix seconds).");
  const day = Math.floor(timestamp / DAY) * DAY;
  const lower = day - DAY;
  const upper = day + 2 * DAY;
  // Match the range supported by the original Python datetime conversions.
  if (lower < -62135596800 || upper > 253402214400) throw new RangeError("Timestamp outside datetime range");
  const { results } = await env.DB.prepare(`
    WITH requested(address) AS (SELECT value FROM json_each(?1))
    SELECT address, older.ts AS older_ts, older.usd_price AS older_price,
      newer.ts AS newer_ts, newer.usd_price AS newer_price
    FROM requested
    LEFT JOIN history older ON older.resource_address = address AND older.ts = (
      SELECT MAX(ts) FROM history WHERE resource_address = address AND ts <= ?2 AND ts > ?3
    )
    LEFT JOIN history newer ON newer.resource_address = address AND newer.ts = (
      SELECT MIN(ts) FROM history WHERE resource_address = address AND ts >= ?2 AND ts < ?4
    )`).bind(JSON.stringify(tokens), timestamp, lower, upper).all();
  const byAddress = new Map(results.map(row => [row.address, row]));
  const found = Object.create(null);
  const missing = [];
  for (const address of tokens) {
    const { older_ts, older_price, newer_ts, newer_price } = byAddress.get(address);
    if (older_ts === null && newer_ts === null) {
      missing.push(address);
      continue;
    }
    const useOlder = newer_ts === null || (older_ts !== null && timestamp - older_ts <= newer_ts - timestamp);
    const ts = useOlder ? older_ts : newer_ts;
    found[address] = {
      usd_price: useOlder ? older_price : newer_price,
      last_updated_at: new Date(ts * 1000).toISOString().replace(".000Z", ""),
    };
  }
  if (missing.length) throw new ApiError(424, `Price missing for tokens: ${missing.join(", ")}`);
  return { prices: found };
}

async function tokenList(ctx) {
  const latest = await latestPrices(ctx);
  return Object.entries(config.tokens).flatMap(([symbol, token], index) => {
    const price = latest.get(token.resource_address);
    return price ? [{
      id: index + 1,
      resource_address: token.resource_address,
      symbol,
      name: Object.hasOwn(token, "name") ? token.name : symbol,
      price: price.usd_price,
      currency: "USD",
    }] : [];
  });
}

async function health(env) {
  const { last_ok, last_error, tokens } = await env.DB.prepare(`
    SELECT last_ok, last_error, (SELECT COUNT(*) FROM latest) AS tokens FROM cycle_status WHERE id = 1`).first();
  const age = last_ok === null ? null : (Date.now() - last_ok) / 1000;
  const ok = age !== null && age < Number(env.INTERVAL_SECS ?? 60) * 5;
  return json({
    Everything: ok ? "Ok" : "Stale",
    last_cycle_age_secs: age === null ? null : Math.round(age),
    last_error,
    tokens,
  }, ok ? 200 : 503);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === "GET" && pathname === "/healthz") return await health(env);
      if (request.method === "POST") {
        const path = pathname.replace(/\/+$/, "");
        if (path === "/price/tokens" || path === "/price/tokens-legacy") {
          return json(await currentPrices(await readBody(request), env, ctx));
        }
        if (path === "/price/historicalPrice" || path === "/price/historicalPrice-legacy") {
          return json(await historicalPrices(request, await readBody(request), env));
        }
        if (path === "/tokens") return json(await tokenList(ctx));
      }
      return json({ detail: "Not Found" }, 404);
    } catch (error) {
      if (error instanceof ApiError) return json({ detail: error.message }, error.status);
      console.error(`Error in ${pathname}`, error);
      return json({ detail: "Internal Server Error" }, 500);
    }
  },

  async scheduled(event, env) {
    await coordinator(env).refresh(event.scheduledTime);
  },
};
