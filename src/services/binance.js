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
let isMockData = false;

function getCached(key, ttlMs) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, ts: Date.now() });
}

function isUsingMockData() { return isMockData; }

const INTERVAL_TTL = {
    '1d': 60_000, '1w': 300_000, '1M': 600_000,
    '4h': 60_000, '6h': 60_000, '1h': 30_000,
};

const FALLBACK_PRICES = {
    BTCUSDT: 108000, ETHUSDT: 2550, SOLUSDT: 178,
    UNIUSDT: 7.2, JUPUSDT: 0.62, AAVEUSDT: 270,
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
    for (const base of BINANCE_ENDPOINTS) {
        try {
            return await tryFetch(base + path);
        } catch (_) {}
    }
    throw new Error('All Binance endpoints failed');
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
    if (Object.keys(map).length === 0) throw new Error('No prices from CoinGecko');
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
        isMockData = false;
        setCache(key, map);
        return map;
    } catch (_) {}

    // Try CoinGecko
    try {
        const map = await fetchPricesFromCoinGecko(symbols);
        isMockData = false;
        setCache(key, map);
        return map;
    } catch (_) {}

    // Fallback mock
    isMockData = true;
    const map = {};
    symbols.forEach(s => {
        map[s] = FALLBACK_PRICES[s] || 100;
    });
    setCache(key, map);
    return map;
}

function generateMockCandles(basePrice, interval, limit) {
    const candles = [];
    const now = Date.now();
    const msPerCandle = {
        '1d': 86400000, '1w': 604800000, '1M': 2592000000,
        '4h': 14400000, '6h': 21600000, '1h': 3600000,
    };
    const step = msPerCandle[interval] || 86400000;
    let price = basePrice * (0.85 + Math.random() * 0.1);

    for (let i = 0; i < limit; i++) {
        const volatility = basePrice * 0.015;
        const drift = (Math.random() - 0.48) * volatility;
        const open = price;
        const close = open + drift;
        const high = Math.max(open, close) + Math.random() * volatility * 0.5;
        const low = Math.min(open, close) - Math.random() * volatility * 0.5;
        const volume = 1000 + Math.random() * 5000;

        candles.push({ ts: now - (limit - i) * step, open, high, low, close, volume });
        price = close;
    }
    return candles;
}

async function fetchKlines(symbol, interval, limit = 100) {
    const key = `klines:${symbol}:${interval}:${limit}`;
    const ttl = INTERVAL_TTL[interval] || 60_000;
    const hit = getCached(key, ttl);
    if (hit) return hit;

    const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    try {
        const raw = await fetchWithMirrors(path);
        const candles = raw.map(k => ({
            ts: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
        }));
        isMockData = false;
        setCache(key, candles);
        return candles;
    } catch (_) {
        isMockData = true;
        const basePrice = FALLBACK_PRICES[symbol] || 100;
        const candles = generateMockCandles(basePrice, interval, limit);
        setCache(key, candles);
        return candles;
    }
}

async function fetchAllPrices() {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'UNIUSDT', 'JUPUSDT', 'AAVEUSDT'];
    return fetchPrices(symbols);
}

// Accept overrides from frontend (real browser prices)
let priceOverrides = {};
function setPriceOverrides(overrides) {
    priceOverrides = { ...overrides };
}
function getPriceOverrides() {
    return priceOverrides;
}

module.exports = { fetchPrices, fetchKlines, fetchAllPrices, isUsingMockData, setPriceOverrides, getPriceOverrides };
