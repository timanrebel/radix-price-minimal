import { D, gateway, httpJson, poolRaw } from "./gateway.js";

function resolvePools(tokens, rawPrices) {
  const pools = new Map();
  const symbols = new Map();
  const busy = new Set();

  function pool(config) {
    const { component, base, quote } = config;
    if (pools.has(component)) return pools.get(component);
    const raw = rawPrices.get(component);
    let price = null;
    if (raw && base === "XRD") {
      price = raw;
    } else if (raw) {
      const quotePrice = symbol(quote);
      if (quotePrice) price = new D(1).div(raw).times(quotePrice);
    }
    pools.set(component, price);
    return price;
  }

  function symbol(name) {
    if (name === "XRD") return new D(1);
    if (symbols.has(name)) return symbols.get(name);
    if (busy.has(name) || !Object.hasOwn(tokens, name)) return null;
    busy.add(name);
    const prices = tokens[name].pools.map(pool).filter(Boolean);
    busy.delete(name);
    const price = prices.length ? D.sum(...prices).div(prices.length) : null;
    symbols.set(name, price);
    return price;
  }

  return { pool, symbol };
}

async function fetchCoinGecko(env, tokens, deadline) {
  const base = env.COINGECKO_URL ?? "https://api.coingecko.com/api/v3";
  const ids = [...new Set(Object.values(tokens).map(token => token.coingecko_id).filter(Boolean))].sort();
  if (!base || !ids.length) return {};
  const query = new URLSearchParams({ ids: ids.join(","), vs_currencies: "usd" });
  try {
    return await httpJson(`${base.replace(/\/+$/, "")}/simple/price?${query}`, env, undefined, deadline);
  } catch (error) {
    console.warn("CoinGecko failed", error.message);
    return {};
  }
}

async function saveCycle(env, prices, accepted, now, scheduledTime) {
  const db = env.DB;
  const timestamp = Math.floor(now / 1000);
  const iso = new Date(now).toISOString().replace(/\.000Z$/, "").replace(/(\.\d{3})Z$/, (_, fraction) => fraction + "000");
  const rows = JSON.stringify(prices);
  const interval = Number(env.HISTORY_EVERY_SECS ?? 300);
  const retention = Number(env.RETENTION_DAYS ?? 400);
  const statements = [
    db.prepare(`INSERT INTO latest (resource_address, usd_price, last_updated_at, price_source)
      SELECT key, value->>0, ?, value->>1 FROM json_each(?) WHERE 1
      ON CONFLICT (resource_address) DO UPDATE SET usd_price = excluded.usd_price,
        last_updated_at = excluded.last_updated_at, price_source = excluded.price_source`).bind(iso, rows),
    db.prepare(`INSERT OR REPLACE INTO history (resource_address, ts, usd_price)
      SELECT key, ?, value->>0 FROM json_each(?)
      WHERE ? - COALESCE((SELECT MAX(ts) FROM history), 0) >= ?`).bind(timestamp, rows, timestamp, interval),
    db.prepare(`INSERT INTO coingecko_cache (id, usd_price, fetched_at)
      SELECT key, value, ? FROM json_each(?) WHERE 1
      ON CONFLICT (id) DO UPDATE SET usd_price = excluded.usd_price, fetched_at = excluded.fetched_at`)
      .bind(timestamp, JSON.stringify(accepted)),
  ];
  if (retention > 0) {
    statements.push(
      db.prepare(`DELETE FROM history WHERE ts < ?
        AND (SELECT last_prune FROM cycle_status WHERE id = 1) < ?`)
        .bind(timestamp - retention * 86400, timestamp - 86400),
      db.prepare("UPDATE cycle_status SET last_prune = ? WHERE id = 1 AND last_prune < ?")
        .bind(timestamp, timestamp - 86400),
    );
  }
  statements.push(db.prepare(`UPDATE cycle_status
    SET last_ok = ?, last_error = NULL, last_scheduled_time = ? WHERE id = 1`).bind(now, scheduledTime));
  await db.batch(statements);
}

export async function refreshPrices(env, config, scheduledTime) {
  const { tokens, usd_anchors: anchors } = config;
  const deadline = AbortSignal.timeout(50_000);
  const { ledger_state: { epoch } } = await gateway(env, "/status/gateway-status", {}, deadline);
  const unique = new Map();
  for (const token of [...anchors.map(name => tokens[name]), ...Object.values(tokens)]) {
    for (const pool of token.pools) {
      if (!unique.has(pool.component)) unique.set(pool.component, pool);
    }
  }
  const pending = unique.values();
  const rawPrices = new Map();
  // Reserve connections for the CoinGecko request and D1 read.
  let throttled;
  const fetchPools = async () => {
    for (const pool of pending) {
      if (deadline.aborted || throttled) break;
      try {
        rawPrices.set(pool.component, await poolRaw(env, pool, epoch, deadline));
      } catch (error) {
        if (error.status === 429) throttled = error;
        console.warn(`pool ${pool.dex} ${pool.component} failed:`, error.message);
      }
    }
  };
  const [fresh, { results: cachedRows }] = await Promise.all([
    fetchCoinGecko(env, tokens, deadline),
    env.DB.prepare("SELECT * FROM coingecko_cache").all(),
    ...Array.from({ length: 4 }, fetchPools),
  ]);

  if (throttled) throw throttled;
  if (deadline.aborted) throw new Error("Price refresh timed out");

  const resolver = resolvePools(tokens, rawPrices);
  const anchorPrices = anchors.flatMap(name => tokens[name].pools.map(resolver.pool))
    .filter(Boolean).map(price => new D(1).div(price)).sort((a, b) => a.cmp(b));
  if (!anchorPrices.length) throw new Error("no anchor pool responded; no USD/XRD price");
  const mid = Math.floor(anchorPrices.length / 2);
  const usdPerXrd = anchorPrices.length % 2 ? anchorPrices[mid] : anchorPrices[mid - 1].plus(anchorPrices[mid]).div(2);

  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const staleness = Number(env.COINGECKO_STALENESS_THRESHOLD_SECS ?? 300);
  const divergence = Number(env.COINGECKO_DIVERGENCE_THRESHOLD ?? 0.5);
  const defaultWeight = Number(env.COINGECKO_DEFAULT_WEIGHT ?? 0.8);
  const cached = new Map(cachedRows.map(row => [row.id, row]));
  const accepted = Object.create(null);
  const prices = Object.create(null);
  for (const [symbol, token] of Object.entries(tokens)) {
    const ledger = symbol === "XRD" ? usdPerXrd.toNumber() : resolver.symbol(symbol)?.times(usdPerXrd).toNumber();
    const id = token.coingecko_id;
    let price = ledger;
    let source = "ledger_only";
    if (id) {
      const current = fresh[id]?.usd;
      const prior = cached.get(id);
      let cg;
      if (Number.isFinite(current) && !(ledger > 0 && Math.abs(current - ledger) / ledger > divergence)) {
        accepted[id] = current;
        cached.set(id, { usd_price: current, fetched_at: nowSeconds });
        cg = current;
        source = "coingecko_weighted";
      } else if (prior && nowSeconds - prior.fetched_at <= staleness) {
        cg = prior.usd_price;
        source = "coingecko_cached";
      }
      if (cg !== undefined) {
        const weight = Number(token.coingecko_weight ?? defaultWeight);
        price = ledger === undefined ? cg : weight * cg + (1 - weight) * ledger;
      }
    }
    if (Number.isFinite(price)) prices[token.resource_address] = [price, source];
  }
  await saveCycle(env, prices, accepted, now, scheduledTime);
  console.info(`Price cycle saved ${Object.keys(prices).length}/${Object.keys(tokens).length} prices`);
}
