const BINANCE_ENDPOINTS = [
    'https://api.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://api3.binance.com',
    'https://data-api.binance.vision',
];

const COINGECKO_IDS = {
    BTCUSDT: 'bitcoin', ETHUSDT: 'ethereum', SOLUSDT: 'solana',
    UNIUSDT: 'uniswap', JUPUSDT: 'jupiter-exchange-solana', AAVEUSDT: 'aave',
};

const cache = new Map();

function getCached(key, ttlMs) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, ts: Date.now() });
}

const INTERVAL_TTL = {
    '1d': 60_000, '1w': 300_000, '1M': 600_000,
    '4h': 60_000, '6h': 60_000, '1h': 30_000,
};

async function tryFetch(url, timeoutMs = 8000) {
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

async function fetchWithMirrors(path) {
    const errors = [];
    for (const base of BINANCE_ENDPOINTS) {
        try {
            return await tryFetch(base + path);
        } catch (e) {
            errors.push(`${base}: ${e.message}`);
        }
    }
    throw new Error('Binance no accesible: ' + errors.join('; '));
}

async function fetchPricesFromCoinGecko(symbols) {
    const ids = symbols.map(s => COINGECKO_IDS[s]).filter(Boolean).join(',');
    if (!ids) throw new Error('No CoinGecko IDs');
    const data = await tryFetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const map = {};
    for (const sym of symbols) {
        const id = COINGECKO_IDS[sym];
        if (id && data[id]?.usd) map[sym] = data[id].usd;
    }
    if (Object.keys(map).length === 0) throw new Error('CoinGecko no devolvió precios');
    return map;
}

async function fetchPrices(symbols) {
    const key = 'prices:' + symbols.join(',');
    const hit = getCached(key, 10_000);
    if (hit) return hit;

    // Try Binance mirrors
    try {
        const url = `/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
        const arr = await fetchWithMirrors(url);
        const map = {};
        arr.forEach(t => { map[t.symbol] = parseFloat(t.price); });
        setCache(key, map);
        return map;
    } catch (_) {}

    // Try CoinGecko
    try {
        const map = await fetchPricesFromCoinGecko(symbols);
        setCache(key, map);
        return map;
    } catch (_) {}

    throw new Error('No se pudieron obtener precios reales de ninguna fuente');
}

async function fetchKlines(symbol, interval, limit = 100) {
    const key = `klines:${symbol}:${interval}:${limit}`;
    const ttl = INTERVAL_TTL[interval] || 60_000;
    const hit = getCached(key, ttl);
    if (hit) return hit;

    const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const raw = await fetchWithMirrors(path);
    const candles = raw.map(k => ({
        ts: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
    }));
    setCache(key, candles);
    return candles;
}

async function fetchAllPrices() {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'UNIUSDT', 'JUPUSDT', 'AAVEUSDT'];
    return fetchPrices(symbols);
}

module.exports = { fetchPrices, fetchKlines, fetchAllPrices };
