# minprice

A minimal Radix token price service for the Radix Wallet. The Cloudflare Worker and the original Python service expose the same JSON API.

| Endpoint | Notes |
|---|---|
| `POST /price/tokens` (and `-legacy`) | `{"currency":"USD","tokens":[...],"lsus":[...]}` → `{"tokens":[...],"lsus":[...]}` |
| `POST /price/historicalPrice` (and `-legacy`) | Requires the `x-api-key` header. Returns the closest sample in the UTC day of the timestamp or either adjacent day. Returns 424 if any token is missing. |
| `POST /tokens` | Configured tokens with their current price. |
| `GET /healthz` | Returns 503 when there is no successful refresh or the last success is at least 5 × the refresh interval old. |

## Cloudflare Worker

A Cron Trigger refreshes the configured pools every minute and writes the latest snapshot and five-minute historical samples to D1. A failed refresh keeps the last successful prices available and records the error in `/healthz`.

The public price routes use POST. The Worker reads its current snapshot and LSU redemption values through internal GETs served by Workers Cache. Snapshot reads are cached for 15 seconds by default. The Worker reuses LSU redemption values for up to five minutes, even when requests contain different combinations of addresses. A single Durable Object coordinates cache misses across locations and serializes Gateway lookups for LSU batches. The historical and health routes read directly from D1. Wallet traffic never triggers pool previews. [Cloudflare Workers Cache examples](https://developers.cloudflare.com/workers/cache/examples/)

### Run locally

Use Node.js 22.12 or newer.

```bash
npm ci
npx wrangler d1 migrations apply DB --local
npm run dev
```

In another terminal, trigger the refresh and query the API.

```bash
curl -s 'http://localhost:8787/__scheduled?cron=*+*+*+*+*'
curl -s http://localhost:8787/healthz
curl -s -X POST http://localhost:8787/price/tokens \
  -H 'Content-Type: application/json' \
  -d '{"currency":"USD","tokens":["resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"]}'
```

The local Worker uses the public Radix Gateway and CoinGecko by default. Set `GATEWAY_URL` or `COINGECKO_URL` in `.dev.vars` to override them. Set `API_KEY` there to enable local historical requests.

### Deploy

Create the database, then add the returned `database_id` to the existing `DB` binding in [wrangler.jsonc](wrangler.jsonc).

```bash
npx wrangler d1 create radix-price-minimal
npx wrangler d1 migrations apply DB --remote
npm run deploy
```

To enable historical requests, set the secret after deploying. Reuse the existing API key if clients already have it configured.

```bash
npx wrangler secret put API_KEY
```

The first successful scheduled refresh populates an empty D1 database. Point the wallet at the deployed HTTPS URL once `/healthz` returns 200. Edit `tokens.json` and redeploy to change the token list. If you change the cron schedule, set `INTERVAL_SECS` to match so the health check uses the new interval.

### Import existing prices and history

After applying the D1 migration and before deploying against the new database, you can import the `latest` and `history` tables from the existing SQLite file.

```bash
sqlite3 -readonly /path/to/minprice.db > /tmp/radix-price-import.sql <<'SQL'
BEGIN;
.mode insert latest
SELECT resource_address, usd_price, last_updated_at, price_source FROM latest;
.mode insert history
SELECT resource_address, ts, usd_price FROM history;
ROLLBACK;
SQL
npx wrangler d1 execute DB --remote --file /tmp/radix-price-import.sql
```

The local read transaction keeps the export consistent. D1 starts reporting a healthy refresh after its first successful cycle.

### Worker settings

Set production overrides in `wrangler.jsonc` under `vars`. `GATEWAY_URL`, `COINGECKO_URL`, `HISTORY_EVERY_SECS`, `RETENTION_DAYS`, and `PLAZA_PROBE_QUOTE` use the defaults listed below. `PRICE_CACHE_SECS` defaults to 15 and `LSU_CACHE_SECS` defaults to 300.

## Pricing and Python service

Prices are computed with the same algorithm as the original `ledger_current_price` DAG:

1. The USD/XRD price comes from stablecoin anchor pools (`usd_anchors`), taking the median across all anchor pools.
2. A token's ledger price is the average over its pools.
3. Tokens with a `coingecko_id` are blended as `weight × CoinGecko + (1 − weight) × ledger`, with a divergence check and an expiring CoinGecko cache.

### Python configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_URL` | `https://mainnet.radixdlt.com` | Gateway API used for previews and LSU lookups. A local Gateway also works. |
| `COINGECKO_URL` | `https://api.coingecko.com/api/v3` | Set it to an empty string to disable CoinGecko. |
| `TOKENS_FILE` | `tokens.json` | Token/pool list. It is reloaded automatically when it changes. |
| `DB_PATH` | `minprice.db` | SQLite file, created automatically. |
| `HOST` / `PORT` | `127.0.0.1` / `8000` | Listen address. Keep it on localhost and put a reverse proxy or tunnel in front. |
| `API_KEY` | empty | Key for `/price/historicalPrice`; when empty that endpoint is disabled. Generate one with `openssl rand -hex 24`. |
| `INTERVAL_SECS` | `60` | Price cycle period. |
| `HISTORY_EVERY_SECS` | `300` | How often a history row is stored. |
| `RETENTION_DAYS` | `400` | History older than this is purged once a day. |
| `PLAZA_PROBE_QUOTE` | `100` | DefiPlaza probe size, in quote-token units. |
| `LOG_LEVEL` | `INFO` | Set it to `DEBUG` to log every HTTP request. |

## 1. Choose tokens and pools

`tokens.json` lists the tokens and pools to track. Measure them against the Gateway:

```bash
python3 liquidity.py                                                   # price + approx. TVL per pool
python3 liquidity.py --min-tvl-xrd 500000 --write tokens.pruned.json   # drop pools below the threshold
```

- The TVL column is approximate: 2 × the XRD held in the component's vaults plus any `pool_rdx1…` referenced in its state. For pools without XRD (TOKEN/DFP2) the quote side is valued at its XRD price.
- If a pool prices fine but shows 0 XRD, the tool could not find its vaults; check that pool by hand before dropping it.
- `usd_anchors` should list stablecoins whose pools agree with each other (for example `["hUSDC", "xUSDC"]`). A depegged or illiquid stablecoin must not be an anchor.
- `--keep-cg-only` keeps tokens that have a `coingecko_id` even when none of their pools pass, so they are priced from CoinGecko only.

### Supported DEXes

Each pool entry looks like `{"dex": ..., "component": ..., "base": ..., "quote": ...}`. `base` and `quote` are symbols defined in `tokens.json`, or `XRD`.

- **`ociswap`** (`price_sqrt`) and **`c9`** (`get_price`): same logic as the original repository.
- **`defiplaza`**: the price is read with `PlazaPair.quote()` in both directions (sell base and buy base) in a single preview. The result is the geometric mean of bid and ask, with the fee excluded. `get_state().p0` is used only to size the probe.
  - Pairs may quote against DFP2 or against XRD. Always check with `liquidity.py`: it calls `get_tokens()` on every DefiPlaza pair and flags any base/quote mismatch.
  - When the quote is not XRD, the price is converted through the quote token's own XRD price, so that token (for example DFP2) must be in `tokens.json` with working pools.
  - For tokens with low divisibility, increase `PLAZA_PROBE_QUOTE` so the rounding inside `quote()` does not distort the price.

Example:

```json
"ZAP": {"resource_address": "resource_rdx1…", "pools": [
  {"dex": "defiplaza", "component": "component_rdx1…", "base": "ZAP", "quote": "DFP2"}]}
```

## 2. Run

```bash
set -a; . ./minprice.env; set +a
python3 minprice.py
curl -s localhost:8000/healthz
curl -s -X POST localhost:8000/price/tokens -H 'Content-Type: application/json' \
  -d '{"currency":"USD","tokens":["resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"]}'
```

### systemd

```bash
sudo useradd -r -s /usr/sbin/nologin minprice
sudo install -d -o minprice /opt/minprice
sudo install -m644 minprice.py tokens.json /opt/minprice/
sudo install -m600 minprice.env.example /etc/minprice.env   # edit API_KEY etc.
sudo install -m644 minprice.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now minprice
journalctl -u minprice -f
```

The unit sets `ProtectHome=yes` and only allows writes to `/var/lib/minprice`, so keep `DB_PATH` there. It also caps the service at `MemoryMax=96M` and `CPUQuota=25%`.

## 3. Expose it to the wallet

The wallet requires HTTPS with a valid certificate. Keep minprice on `127.0.0.1` and choose one of these:

- **Cloudflare Tunnel.** Works behind NAT or CGNAT without opening any port.
  - For a quick test, run `cloudflared tunnel --url http://127.0.0.1:8000`. It prints a temporary `https://….trycloudflare.com` URL that changes on every run.
  - For a fixed URL, use a named tunnel with your own domain.
- **nginx + Let's Encrypt on a host with a public IP.** Use `proxy_pass http://127.0.0.1:8000` and obtain the certificate with `certbot --nginx`. This does not work behind CGNAT.
- **A small VPS** running minprice directly (about 30 MB RSS), with nginx and TLS in front.

Then add `https://YOUR_HOST/` as a token price service URL in the wallet.

## Tests

Run the Worker integration checks against a mocked Gateway and a local D1 database.

```bash
python3 tests/worker_integration.py
```

Run the original Python service tests.

```bash
python3 -m unittest -v test_minprice     # mocked Gateway and CoinGecko
```
