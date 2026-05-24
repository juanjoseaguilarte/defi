const { getDb } = require('../../db/init');

const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'UNIUSDT', 'JUPUSDT', 'AAVEUSDT'];
const INTERVALS = ['1d', '1w', '1M'];

const BINANCE_ENDPOINTS = [
    'https://api.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://api3.binance.com',
    'https://data-api.binance.vision',
];

async function tryFetch(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

async function fetchKlinesFromBinance(path) {
    for (const base of BINANCE_ENDPOINTS) {
        try {
            return await tryFetch(base + path);
        } catch (_) {}
    }
    throw new Error('All Binance endpoints failed');
}

function saveCandles(db, pair, interval, rawKlines) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO candles (pair, interval, open_time, open, high, low, close, volume, close_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((rows) => {
        for (const k of rows) {
            stmt.run(
                pair, interval,
                k[0],
                parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]),
                parseFloat(k[5]),
                k[6]
            );
        }
    });

    insertMany(rawKlines);
    return rawKlines.length;
}

async function syncPairInterval(pair, interval, limit = 365) {
    const db = getDb();

    const last = db.prepare(
        'SELECT MAX(open_time) as last_ts FROM candles WHERE pair = ? AND interval = ?'
    ).get(pair, interval);

    let startTime = null;
    if (last?.last_ts) {
        startTime = last.last_ts + 1;
    } else {
        const msPerCandle = { '1d': 86400000, '1w': 604800000, '1M': 2592000000 };
        const step = msPerCandle[interval] || 86400000;
        startTime = Date.now() - (limit * step);
    }

    let totalSynced = 0;
    let currentStart = startTime;

    while (true) {
        const path = `/api/v3/klines?symbol=${pair}&interval=${interval}&startTime=${currentStart}&limit=1000`;

        let raw;
        try {
            raw = await fetchKlinesFromBinance(path);
        } catch (e) {
            console.error(`[Sync] ${pair} ${interval}: Binance error — ${e.message}`);
            break;
        }

        if (!raw || raw.length === 0) break;

        const count = saveCandles(db, pair, interval, raw);
        totalSynced += count;

        const lastOpenTime = raw[raw.length - 1][0];
        currentStart = lastOpenTime + 1;

        if (raw.length < 1000) break;

        await new Promise(r => setTimeout(r, 300));
    }

    if (totalSynced > 0) {
        db.prepare(`
            INSERT INTO sync_log (pair, interval, candles_synced, last_open_time)
            VALUES (?, ?, ?, ?)
        `).run(pair, interval, totalSynced, currentStart);
    }

    db.close();
    return totalSynced;
}

async function syncAll() {
    console.log('[Sync] Starting full sync...');
    const results = [];

    for (const pair of PAIRS) {
        for (const interval of INTERVALS) {
            try {
                const count = await syncPairInterval(pair, interval);
                if (count > 0) {
                    console.log(`[Sync] ${pair} ${interval}: ${count} candles saved`);
                }
                results.push({ pair, interval, count, ok: true });
            } catch (e) {
                console.error(`[Sync] ${pair} ${interval}: ERROR — ${e.message}`);
                results.push({ pair, interval, count: 0, ok: false, error: e.message });
            }

            await new Promise(r => setTimeout(r, 200));
        }
    }

    console.log('[Sync] Full sync complete');
    return results;
}

function getCandlesFromDb(pair, interval, limit = 365) {
    const db = getDb();
    const rows = db.prepare(`
        SELECT open_time, open, high, low, close, volume, close_time
        FROM candles
        WHERE pair = ? AND interval = ?
        ORDER BY open_time DESC
        LIMIT ?
    `).all(pair, interval, limit);
    db.close();

    return rows.reverse().map(r => ({
        ts: r.open_time,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
    }));
}

function getSyncStatus() {
    const db = getDb();

    const counts = db.prepare(`
        SELECT pair, interval, COUNT(*) as total,
               MIN(open_time) as first_ts, MAX(open_time) as last_ts
        FROM candles
        GROUP BY pair, interval
        ORDER BY pair, interval
    `).all();

    const lastSync = db.prepare(`
        SELECT pair, interval, candles_synced, synced_at
        FROM sync_log
        ORDER BY id DESC
        LIMIT 20
    `).all();

    db.close();

    return {
        candles: counts.map(c => ({
            pair: c.pair,
            interval: c.interval,
            total: c.total,
            from: new Date(c.first_ts).toISOString(),
            to: new Date(c.last_ts).toISOString(),
        })),
        recent_syncs: lastSync,
    };
}

function startPeriodicSync(intervalMs = 3600000) {
    syncAll().catch(e => console.error('[Sync] Initial sync error:', e.message));

    setInterval(() => {
        syncAll().catch(e => console.error('[Sync] Periodic sync error:', e.message));
    }, intervalMs);

    console.log(`[Sync] Periodic sync scheduled every ${intervalMs / 60000} min`);
}

module.exports = { syncAll, syncPairInterval, getCandlesFromDb, getSyncStatus, startPeriodicSync, PAIRS, INTERVALS };
