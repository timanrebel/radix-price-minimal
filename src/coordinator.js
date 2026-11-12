import { DurableObject } from "cloudflare:workers";
import config from "../tokens.json";
import { redemptionValues } from "./gateway.js";
import { refreshPrices } from "./pricing.js";

export class GatewayCoordinator extends DurableObject {
  cycle = null;
  lsuQueue = Promise.resolve();
  retryLsusAt = 0;

  refresh(scheduledTime) {
    if (this.cycle) return this.cycle;
    this.cycle = this.runCycle(scheduledTime).finally(() => { this.cycle = null; });
    return this.cycle;
  }

  async runCycle(scheduledTime) {
    const status = await this.env.DB.prepare("SELECT last_scheduled_time FROM cycle_status WHERE id = 1").first();
    if (status.last_scheduled_time >= scheduledTime) return;
    try {
      await refreshPrices(this.env, config, scheduledTime);
    } catch (error) {
      await this.env.DB.prepare("UPDATE cycle_status SET last_error = ? WHERE id = 1")
        .bind(error.message).run();
      throw error;
    }
  }

  lsus(addresses) {
    // Recheck shared storage after earlier batches finish, including batches with different keys.
    const result = this.lsuQueue.then(() => this.readLsus(addresses));
    this.lsuQueue = result.catch(() => {});
    return result;
  }

  async readLsus(addresses) {
    const now = Date.now();
    const db = this.env.DB;
    const { results: cached } = await db.prepare(`SELECT address, value, expires_at FROM lsu_cache
      WHERE address IN (SELECT value FROM json_each(?)) AND expires_at > ?`).bind(JSON.stringify(addresses), now).all();
    const rows = new Map(cached.map(row => [row.address, row]));
    const missing = addresses.filter(address => !rows.has(address));
    let failed = false;
    if (missing.length) {
      try {
        if (now < this.retryLsusAt) {
          failed = true;
        } else {
          const values = await redemptionValues(this.env, missing);
          const ttl = Number(this.env.LSU_CACHE_SECS ?? 300);
          const fetchedAt = Date.now();
          const updates = missing.map(address => {
            const value = values.get(address) ?? null;
            const expires_at = fetchedAt + (value === null ? Math.min(15, ttl) : ttl) * 1000;
            return { address, value, expires_at };
          });
          await db.batch([
            db.prepare("DELETE FROM lsu_cache WHERE expires_at <= ?").bind(fetchedAt),
            db.prepare(`INSERT INTO lsu_cache (address, value, expires_at)
              SELECT value->>'address', value->>'value', value->>'expires_at' FROM json_each(?) WHERE 1
              ON CONFLICT (address) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`)
              .bind(JSON.stringify(updates)),
          ]);
          for (const row of updates) rows.set(row.address, row);
        }
      } catch (error) {
        if (!error.status || error.status === 429 || error.status >= 500) {
          this.retryLsusAt = Date.now() + 5000;
        }
        console.warn(`LSU redemption failed for ${missing.length} addresses:`, error.message);
        failed = true;
      }
    }

    const values = [];
    let expiry = Infinity;
    for (const [address, row] of rows) {
      if (row.value !== null) values.push([address, row.value]);
      expiry = Math.min(expiry, row.expires_at);
    }
    const maxAge = failed || !addresses.length ? 0 : Math.max(0, Math.floor((expiry - Date.now()) / 1000));
    return { values, maxAge };
  }
}
