CREATE TABLE IF NOT EXISTS latest (
    resource_address TEXT PRIMARY KEY,
    usd_price REAL NOT NULL,
    last_updated_at TEXT NOT NULL,
    price_source TEXT
);

CREATE TABLE IF NOT EXISTS history (
    resource_address TEXT NOT NULL,
    ts INTEGER NOT NULL,
    usd_price REAL NOT NULL,
    PRIMARY KEY (resource_address, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS history_by_ts ON history (ts);

CREATE TABLE IF NOT EXISTS cycle_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_ok INTEGER,
    last_error TEXT,
    last_scheduled_time INTEGER,
    last_prune INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO cycle_status (id) VALUES (1);

CREATE TABLE IF NOT EXISTS coingecko_cache (
    id TEXT PRIMARY KEY,
    usd_price REAL NOT NULL,
    fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lsu_cache (
    address TEXT PRIMARY KEY,
    value REAL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS lsu_by_expiry ON lsu_cache (expires_at);
