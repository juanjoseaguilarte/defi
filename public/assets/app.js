/* ═══════════════════════════════════════════════════════════════
   APP — Navigation, Rangos, Analyst, Signals, Aave, Charts
   ═══════════════════════════════════════════════════════════════ */

const APP_BASE = '';

// ── Splash ──────────────────────────────────────────────────────
window.addEventListener('load', () => {
    setTimeout(() => {
        const splash = document.getElementById('splash');
        splash.classList.add('fade-out');
        document.getElementById('app').style.display = '';
        setTimeout(() => splash.remove(), 500);
    }, 1300);
});

// ── Navigation ──────────────────────────────────────────────────
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page-view');
const pageLoaded = {};

navItems.forEach(btn => {
    btn.addEventListener('click', () => {
        const page = btn.dataset.page;
        navItems.forEach(b => b.classList.remove('nav-item--active'));
        btn.classList.add('nav-item--active');
        pages.forEach(p => { p.style.display = 'none'; });
        const el = document.getElementById('page-' + page);
        if (el) {
            el.style.display = '';
            el.style.animation = 'none';
            el.offsetHeight;
            el.style.animation = '';
        }
        if (!pageLoaded[page]) {
            pageLoaded[page] = true;
            if (page === 'analyst') loadAnalyst();
            if (page === 'signals') loadSignals();
            if (page === 'strategy') initTracker();
            if (page === 'daytrader') { restoreTradesIfNeeded().then(() => loadOpenTrades()); }
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// RANGOS
// ═══════════════════════════════════════════════════════════════

const PAIR_META = {
    'BTCUSDT':  { label: 'BTC',     type: 'normal',    dec: 2 },
    'ETHUSDT':  { label: 'ETH',     type: 'normal',    dec: 2 },
    'SOLUSDT':  { label: 'SOL',     type: 'normal',    dec: 3 },
    'UNIUSDT':  { label: 'UNI',     type: 'normal',    dec: 4 },
    'JUPUSDT':  { label: 'JUP',     type: 'normal',    dec: 4 },
    'AAVEUSDT': { label: 'AAVE',    type: 'normal',    dec: 2 },
    'BTCETH':   { label: 'BTC/ETH', type: 'synthetic', dec: 4 },
    'BTCSOL':   { label: 'BTC/SOL', type: 'synthetic', dec: 2 },
    'ETHSOL':   { label: 'ETH/SOL', type: 'synthetic', dec: 3 },
    'SOLJUP':   { label: 'SOL/JUP', type: 'synthetic', dec: 2 },
};

const SYNTHETIC_BASES = {
    'BTCETH': ['BTCUSDT', 'ETHUSDT'],
    'BTCSOL': ['BTCUSDT', 'SOLUSDT'],
    'ETHSOL': ['ETHUSDT', 'SOLUSDT'],
    'SOLJUP': ['SOLUSDT', 'JUPUSDT'],
};

let currentPairKey = 'BTCUSDT';
let currentDec = 2;

// ═══════════════════════════════════════════════════════════════
// CLIENT-SIDE RANGE CALCULATION (fallback when backend has mock data)
// ═══════════════════════════════════════════════════════════════

function clientFindMR(candles) {
    const results = [];
    for (let i = 3; i < candles.length - 3; i++) {
        const h = candles[i][1]; // high
        if (h > candles[i-1][1] && h > candles[i-2][1] && h > candles[i-3][1] &&
            h > candles[i+1][1] && h > candles[i+2][1] && h > candles[i+3][1]) {
            results.push({ i, v: h });
        }
    }
    return results;
}

function clientFindmR(candles) {
    const results = [];
    for (let i = 3; i < candles.length - 3; i++) {
        const l = candles[i][2]; // low
        if (l < candles[i-1][2] && l < candles[i-2][2] && l < candles[i-3][2] &&
            l < candles[i+1][2] && l < candles[i+2][2] && l < candles[i+3][2]) {
            results.push({ i, v: l });
        }
    }
    return results;
}

function clientCalcRange(candles, price) {
    if (!candles || candles.length < 10) return null;
    const mrs = clientFindMR(candles);
    const mrs_low = clientFindmR(candles);

    let sup, res, breakdown = false, breakout = false;

    // Sort by proximity to price, not chronological order
    const supLevels = mrs_low.filter(m => m.v <= price).sort((a, b) => b.v - a.v);
    const resLevels = mrs.filter(m => m.v >= price).sort((a, b) => a.v - b.v);

    if (supLevels.length > 0) {
        sup = supLevels[0].v; // nearest mR below price
    } else {
        breakdown = true;
        sup = Math.min(...candles.slice(-10).map(c => c[2]));
    }

    if (resLevels.length > 0) {
        res = resLevels[0].v; // nearest MR above price
    } else {
        breakout = true;
        res = Math.max(...candles.slice(-10).map(c => c[1]));
    }

    if (breakdown && mrs_low.length > 0) {
        const nearest = mrs_low.filter(m => m.v > price).sort((a, b) => a.v - b.v);
        if (nearest.length > 0) res = nearest[0].v;
    }
    if (breakout && mrs.length > 0) {
        const nearest = mrs.filter(m => m.v < price).sort((a, b) => b.v - a.v);
        if (nearest.length > 0) sup = nearest[0].v;
    }

    if (sup > price) sup = Math.min(...candles.slice(-10).map(c => c[2]));
    if (res < price) res = Math.max(...candles.slice(-10).map(c => c[1]));
    if (sup > price) sup = price * 0.98;
    if (res < price) res = price * 1.02;
    if (sup >= res) { sup = price * 0.97; res = price * 1.03; }

    const mid = (sup + res) / 2;
    const widthPct = mid > 0 ? ((res - sup) / mid * 100) : 0;
    const last = candles[candles.length - 1];

    return {
        sup, mid, res,
        width_pct: widthPct,
        closed_at: new Date(last[4] || Date.now()).toISOString(),
        _breakdown: breakdown,
        _breakout: breakout,
    };
}

async function fetchBinanceKlines(symbol, interval, limit) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const raw = await r.json();
    // Return as [open, high, low, close, closeTime]
    return raw.map(k => [parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), k[6]]);
}

function clientDetectTrend(candles) {
    if (candles.length < 40) return 'LATERAL';
    const closes = candles.map(c => c[3]);
    const sma20 = [], sma40 = [];
    for (let i = 0; i < closes.length; i++) {
        if (i < 19) { sma20.push(null); } else {
            let s = 0; for (let j = i - 19; j <= i; j++) s += closes[j]; sma20.push(s / 20);
        }
        if (i < 39) { sma40.push(null); } else {
            let s = 0; for (let j = i - 39; j <= i; j++) s += closes[j]; sma40.push(s / 40);
        }
    }
    const v20 = sma20.filter(v => v !== null);
    const v40 = sma40.filter(v => v !== null);
    if (v20.length < 5 || v40.length < 5) return 'LATERAL';
    const s20 = (v20[v20.length-1] - v20[v20.length-5]) / v20[v20.length-5] * 100;
    const s40 = (v40[v40.length-1] - v40[v40.length-5]) / v40[v40.length-5] * 100;
    const last20 = v20[v20.length-1], last40 = v40[v40.length-1];
    if (s20 > 0.15 && s40 > 0.1 && last20 > last40) return 'ALCISTA';
    if (s20 < -0.15 && s40 < -0.1 && last20 < last40) return 'BAJISTA';
    return 'LATERAL';
}

async function calculateRangesLocally(pair, price) {
    const symbol = SYNTHETIC_BASES[pair] ? null : pair;
    if (!symbol) return null; // synthetic pairs skip local calc for now

    // Fetch enough for trend (SMA40 needs 40+), but use shorter windows for pivots
    const [dailyKFull, weeklyKFull, monthlyK] = await Promise.all([
        fetchBinanceKlines(symbol, '1d', 60),
        fetchBinanceKlines(symbol, '1w', 20),
        fetchBinanceKlines(symbol, '1M', 12),
    ]);

    const trend = clientDetectTrend(dailyKFull);

    return {
        pair,
        current_price: price,
        trend,
        vol_percentile: 50,
        daily: clientCalcRange(dailyKFull.slice(-30), price),
        weekly: clientCalcRange(weeklyKFull.slice(-12), price),
        monthly: clientCalcRange(monthlyK, price),
        _local: true,
    };
}
let lastRangeData = null;
let liveTickerTimer = null;
let latestPrices = {};

// Build pair tabs
(function buildPairTabs() {
    const scroller = document.getElementById('pairScroller');
    let html = '';
    for (const [key, meta] of Object.entries(PAIR_META)) {
        const active = key === 'BTCUSDT' ? 'pair-tab--active' : '';
        html += `<button class="pair-tab ${active}" data-pair="${key}" onclick="selectPair(this)">${meta.label}</button>`;
    }
    scroller.innerHTML = html;
})();

// Build range cards
(function buildRangeCards() {
    const grid = document.getElementById('rangesGrid');
    const tfs = [
        { key: 'daily', label: 'Diario' },
        { key: 'weekly', label: 'Semanal' },
        { key: 'monthly', label: 'Mensual' },
    ];
    let html = '';
    for (const tf of tfs) {
        html += `
        <div class="range-card" id="card_${tf.key}">
            <div class="range-card__header">
                <span class="range-card__tf">${tf.label}</span>
                <span class="range-card__info">
                    <span class="range-card__closed" id="closed_${tf.key}"></span>
                    <span class="range-card__width" id="width_${tf.key}"></span>
                </span>
            </div>
            <div class="rng-posbar">
                <span class="rng-posbar__label rng-posbar__label--sup" id="sup_${tf.key}">&mdash;</span>
                <div class="rng-posbar__track">
                    <div class="rng-posbar__bear-zone" id="bear_${tf.key}"></div>
                    <div class="rng-posbar__bull-zone" id="bull_${tf.key}"></div>
                    <div class="rng-posbar__mid-tick" id="midtick_${tf.key}">
                        <span class="rng-posbar__mid-label" id="mid_${tf.key}">&mdash;</span>
                    </div>
                    <div class="rng-posbar__dot" id="dot_${tf.key}"></div>
                </div>
                <span class="rng-posbar__label rng-posbar__label--res" id="res_${tf.key}">&mdash;</span>
            </div>
            <div class="range-vals">
                <div class="range-val range-val--sup">
                    <span class="range-val__label">Soporte</span>
                    <span class="range-val__num" id="supVal_${tf.key}">&mdash;</span>
                </div>
                <div class="range-val range-val--mid">
                    <span class="range-val__label">Midpoint</span>
                    <span class="range-val__num" id="midVal_${tf.key}">&mdash;</span>
                </div>
                <div class="range-val range-val--res">
                    <span class="range-val__label">Resistencia</span>
                    <span class="range-val__num" id="resVal_${tf.key}">&mdash;</span>
                </div>
            </div>
        </div>`;
    }
    grid.innerHTML = html;
})();

function fmt(n, dec) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function selectPair(btn) {
    document.querySelectorAll('.pair-tab').forEach(b => b.classList.remove('pair-tab--active'));
    btn.classList.add('pair-tab--active');
    currentPairKey = btn.dataset.pair;
    const meta = PAIR_META[currentPairKey] || {};
    currentDec = meta.dec || 2;
    document.getElementById('currentPairLabel').textContent = meta.label || currentPairKey;
    loadRanges();
}

function setRangeLoading(on) {
    document.getElementById('rangeLoading').style.display = on ? 'flex' : 'none';
    document.getElementById('rangesGrid').style.opacity = on ? '0.35' : '1';
}

function renderBar(key, sup, mid, res, price, dec) {
    const range = res - sup;
    if (range <= 0) return;
    const pricePos = Math.min(100, Math.max(0, (price - sup) / range * 100));
    const midPos = Math.min(100, Math.max(0, (mid - sup) / range * 100));

    document.getElementById('dot_' + key).style.left = pricePos.toFixed(1) + '%';
    document.getElementById('midtick_' + key).style.left = midPos.toFixed(1) + '%';
    document.getElementById('mid_' + key).textContent = fmt(mid, dec);

    const aboveMid = price > mid;
    document.getElementById('bear_' + key).style.width = pricePos.toFixed(1) + '%';
    document.getElementById('bear_' + key).style.opacity = aboveMid ? '0.4' : '0.8';
    document.getElementById('bull_' + key).style.width = (100 - pricePos).toFixed(1) + '%';
    document.getElementById('bull_' + key).style.opacity = aboveMid ? '0.8' : '0.4';

    document.getElementById('sup_' + key).textContent = fmt(sup, dec);
    document.getElementById('res_' + key).textContent = fmt(res, dec);

    const supBox = document.getElementById('supVal_' + key).closest('.range-val');
    const resBox = document.getElementById('resVal_' + key).closest('.range-val');
    if (supBox && resBox) {
        supBox.classList.toggle('range-val--breakdown', price < sup);
        resBox.classList.toggle('range-val--breakout', price > res);
    }
}

function fmtClosedAt(isoStr) {
    if (!isoStr) return '';
    return 'Cierre: ' + new Date(isoStr).toLocaleDateString('es-ES', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
    }) + ' UTC';
}

function renderRanges(data) {
    const dec = currentDec;
    const price = data.current_price;
    document.getElementById('currentPrice').textContent = fmt(price, dec);

    const tb = document.getElementById('trendBadge');
    tb.textContent = data.trend || '—';
    tb.className = 'trend-badge ' + (
        data.trend === 'ALCISTA' ? 'trend-badge--bull' :
        data.trend === 'BAJISTA' ? 'trend-badge--bear' : ''
    );
    document.getElementById('volBadge').textContent = `Vol: ${data.vol_percentile ?? '—'}%`;

    const tfs = { daily: data.daily, weekly: data.weekly, monthly: data.monthly };
    for (const [key, d] of Object.entries(tfs)) {
        if (!d) continue;
        document.getElementById('supVal_' + key).textContent = fmt(d.sup, dec);
        document.getElementById('midVal_' + key).textContent = fmt(d.mid, dec);
        document.getElementById('resVal_' + key).textContent = fmt(d.res, dec);

        const closedEl = document.getElementById('closed_' + key);
        if (closedEl) closedEl.textContent = fmtClosedAt(d.closed_at);

        const widthEl = document.getElementById('width_' + key);
        if (widthEl) {
            let widthText = d.width_pct ? `Rango: ${d.width_pct.toFixed(1)}%` : '';
            if (d._breakdown) widthText = 'BREAKDOWN ↓';
            if (d._breakout) widthText = 'BREAKOUT ↑';
            widthEl.textContent = widthText;
        }

        renderBar(key, d.sup, d.mid, d.res, price, dec);
    }
    lastRangeData = data;
    startLiveTicker();
}

async function fetchLivePrices() {
    try {
        const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'UNIUSDT', 'JUPUSDT', 'AAVEUSDT'];
        const url = 'https://api.binance.com/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(symbols));
        const r = await fetch(url);
        if (!r.ok) return;
        const arr = await r.json();
        arr.forEach(t => { latestPrices[t.symbol] = parseFloat(t.price); });
    } catch (_) {}
}

function updateLiveBars(price) {
    if (!lastRangeData) return;
    const dec = currentDec;
    document.getElementById('currentPrice').textContent = fmt(price, dec);
    const tfs = { daily: lastRangeData.daily, weekly: lastRangeData.weekly, monthly: lastRangeData.monthly };
    for (const [key, d] of Object.entries(tfs)) {
        if (d) renderBar(key, d.sup, d.mid, d.res, price, dec);
    }
}

async function tickLivePrice() {
    await fetchLivePrices();
    if (!lastRangeData) return;
    let livePrice;
    if (latestPrices[currentPairKey]) {
        livePrice = latestPrices[currentPairKey];
    } else if (SYNTHETIC_BASES[currentPairKey]) {
        const [b, q] = SYNTHETIC_BASES[currentPairKey];
        const pb = latestPrices[b], pq = latestPrices[q];
        if (pb && pq) livePrice = pb / pq;
    }
    if (livePrice) updateLiveBars(livePrice);
}

function startLiveTicker() {
    if (liveTickerTimer) clearInterval(liveTickerTimer);
    tickLivePrice();
    liveTickerTimer = setInterval(tickLivePrice, 5000);
}

async function loadRanges() {
    setRangeLoading(true);
    document.getElementById('currentPrice').textContent = '—';
    try {
        await fetchLivePrices();

        const meta = PAIR_META[currentPairKey] || {};

        let livePrice;
        if (latestPrices[currentPairKey]) {
            livePrice = latestPrices[currentPairKey];
        } else if (SYNTHETIC_BASES[currentPairKey]) {
            const [b, q] = SYNTHETIC_BASES[currentPairKey];
            if (latestPrices[b] && latestPrices[q]) livePrice = latestPrices[b] / latestPrices[q];
        }

        if (!livePrice) throw new Error('No se pudo obtener precio real de Binance');

        // 1) Calculate ranges locally from real Binance klines (browser can always reach Binance)
        let data;
        if (meta.type !== 'synthetic') {
            data = await calculateRangesLocally(currentPairKey, livePrice);
            if (!data) throw new Error('No se pudieron calcular rangos');
        } else {
            // Synthetic pairs: try backend
            const apiPath = '/api/synthetic';
            let url = `${APP_BASE}${apiPath}?pair=${currentPairKey}&price=${livePrice}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            data = await resp.json();
            if (data.error) throw new Error(data.error);
            data.current_price = livePrice;
        }

        // 2) Apply custom admin overrides from backend
        try {
            const overResp = await fetch(`${APP_BASE}/api/ranges?pair=${currentPairKey}&price=${livePrice}`);
            if (overResp.ok) {
                const overData = await overResp.json();
                if (!overData.error) {
                    for (const tf of ['daily', 'weekly', 'monthly']) {
                        if (overData[tf]?._custom) data[tf] = overData[tf];
                    }
                }
            }
        } catch (_) {}

        renderRanges(data);
    } catch (e) {
        document.getElementById('currentPrice').textContent = 'Error';
        console.error('Rangos error:', e);
    } finally {
        setRangeLoading(false);
    }
}

loadRanges();
setInterval(loadRanges, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// ANALYST
// ═══════════════════════════════════════════════════════════════

const PHASE_ICONS = {
    bull: '\u{1F7E2}', bear: '\u{1F534}',
    distribution: '\u{1F7E1}', accumulation: '\u{1F535}',
};

const TF_INTERVAL = { 'Mensual': 'M', 'Semanal': '10080', 'Diario': '1440', '6H': '360', '1H': '60', '15M': '15' };
const COIN_PAIR = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', UNI: 'UNIUSDT', JUP: 'JUPUSDT', AAVE: 'AAVEUSDT' };

let analystData = null;

function phaseShortLabel(type) {
    if (type === 'bull') return 'E2 Avance';
    if (type === 'bear') return 'E4 Declive';
    if (type === 'distribution') return 'E3 Distrib.';
    if (type === 'accumulation') return 'E1 Acum.';
    if (type === 'range') return 'E1 Acum.';
    return '—';
}

function renderAnalyst(data) {
    analystData = data;
    const tbody = document.getElementById('analystBody');
    document.getElementById('analystUpdated').textContent =
        'Actualizado: ' + new Date(data.calculated_at).toLocaleTimeString('es-ES');

    let html = '';
    for (const coin of data.coins) {
        html += `<tr><td class="col-coin"><span class="coin-name">${coin}</span></td>`;
        for (const tf of data.timeframes) {
            const cell = data.results[coin]?.[tf];
            if (!cell) { html += `<td class="cell-empty">—</td>`; continue; }
            const icon = cell.style?.emoji || PHASE_ICONS[cell.type] || '⚫';
            const label = phaseShortLabel(cell.type);
            const style = `background:${cell.style.bg};color:${cell.style.color}`;
            html += `<td class="phase-cell" style="${style}" onclick="showDetail('${coin}','${tf}')">
                <span class="phase-icon">${icon}</span>
                <span class="phase-label">${label}</span>
                ${cell.is_stale ? '<span style="font-size:0.6rem">⚠</span>' : ''}
            </td>`;
        }
        html += `</tr>`;
    }
    tbody.innerHTML = html;
}

// ── Mini Chart ──────────────────────────────────────────────────
function drawChart(canvas, chartData, phaseColor) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth || 320;
    const H = canvas.offsetHeight || 140;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const candles = chartData.candles;
    const n = candles.length;
    if (!n) return;

    const sma20 = chartData.sma20 || [];
    const sma40 = chartData.sma40 || [];
    const shiArr = chartData.swing_highs || [];
    const sloArr = chartData.swing_lows || [];

    let minP = Infinity, maxP = -Infinity;
    candles.forEach(([o, h, l, c]) => {
        if (h > maxP) maxP = h;
        if (l < minP) minP = l;
    });
    const pad = (maxP - minP) * 0.08;
    minP -= pad; maxP += pad;
    const priceRange = maxP - minP;

    const PAD_L = 4, PAD_R = 4, PAD_T = 8, PAD_B = 4;
    const chartW = W - PAD_L - PAD_R;
    const chartH = H - PAD_T - PAD_B;
    const candleW = Math.max(2, Math.floor(chartW / n) - 1);
    const halfC = candleW / 2;

    const toX = i => PAD_L + (i + 0.5) * (chartW / n);
    const toY = v => PAD_T + chartH * (1 - (v - minP) / priceRange);

    ctx.clearRect(0, 0, W, H);

    // SMA40
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(251,191,36,0.5)';
    ctx.lineWidth = 1.2;
    let first40 = true;
    sma40.forEach((v, i) => {
        if (v === null) return;
        const x = toX(i), y = toY(v);
        if (first40) { ctx.moveTo(x, y); first40 = false; }
        else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // SMA20
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(167,139,250,0.8)';
    ctx.lineWidth = 1.5;
    let first = true;
    sma20.forEach((v, i) => {
        if (v === null) return;
        const x = toX(i), y = toY(v);
        if (first) { ctx.moveTo(x, y); first = false; }
        else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Current price line
    const curY = toY(chartData.current);
    ctx.beginPath();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = (phaseColor || '#818cf8') + 'aa';
    ctx.lineWidth = 1;
    ctx.moveTo(PAD_L, curY);
    ctx.lineTo(W - PAD_R, curY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Candles
    candles.forEach(([o, h, l, c], i) => {
        const bull = c >= o;
        const x = toX(i);
        const yH = toY(h), yL = toY(l);
        const yO = toY(o), yC = toY(c);

        ctx.strokeStyle = bull ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.9)';
        ctx.fillStyle = bull ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)';
        ctx.lineWidth = 1;

        ctx.beginPath();
        ctx.moveTo(x, yH); ctx.lineTo(x, yL);
        ctx.stroke();

        const bodyTop = Math.min(yO, yC);
        const bodyH = Math.max(1, Math.abs(yO - yC));
        ctx.fillRect(x - halfC, bodyTop, candleW, bodyH);
    });

    // Swing highs
    ctx.fillStyle = '#ef4444';
    shiArr.forEach(({ i, v }) => {
        const x = toX(i), y = toY(v) - 6;
        ctx.beginPath();
        ctx.moveTo(x, y + 5); ctx.lineTo(x - 4, y); ctx.lineTo(x + 4, y);
        ctx.closePath(); ctx.fill();
    });

    // Swing lows
    ctx.fillStyle = '#22c55e';
    sloArr.forEach(({ i, v }) => {
        const x = toX(i), y = toY(v) + 6;
        ctx.beginPath();
        ctx.moveTo(x, y - 5); ctx.lineTo(x - 4, y); ctx.lineTo(x + 4, y);
        ctx.closePath(); ctx.fill();
    });

    // Price label
    ctx.fillStyle = phaseColor || '#818cf8';
    ctx.font = 'bold 9px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(Number(chartData.current).toLocaleString('es-ES', { maximumFractionDigits: 0 }), W - PAD_R - 1, curY - 2);
}

async function loadChart(coin, tf, phaseColor) {
    const canvas = document.getElementById('detailChart');
    const loading = document.getElementById('detailChartLoading');
    loading.classList.remove('hidden');
    canvas.style.visibility = 'hidden';

    const interval = TF_INTERVAL[tf] || '1440';
    const pair = COIN_PAIR[coin] || coin + 'USDT';

    try {
        const resp = await fetch(`${APP_BASE}/api/candles_detail?pair=${pair}&interval=${interval}`);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);

        loading.classList.add('hidden');
        canvas.style.visibility = 'visible';
        requestAnimationFrame(() => drawChart(canvas, data, phaseColor));
    } catch (e) {
        loading.classList.add('hidden');
        console.error('Chart error:', e);
    }
}

function showDetail(coin, tf) {
    if (!analystData) return;
    const cell = analystData.results[coin]?.[tf];
    if (!cell) return;

    const dec = coin === 'BTC' || coin === 'ETH' ? 2 : (coin === 'SOL' ? 3 : 4);

    document.getElementById('detailCoin').textContent = coin;
    document.getElementById('detailTF').textContent = tf;
    document.getElementById('detailPhase').textContent = `${cell.style?.emoji || ''} ${cell.phase}`;
    document.getElementById('detailPhase').style.color = cell.style.color;
    document.getElementById('detailReason').textContent = cell.reason || '—';
    document.getElementById('detailPrice').textContent =
        Number(cell.price).toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });

    const panel = document.getElementById('detailPanel');
    panel.style.display = 'flex';
    panel.getBoundingClientRect();
    panel.classList.add('detail-panel--open');

    loadChart(coin, tf, cell.style.color);
}

function closeDetail() {
    const panel = document.getElementById('detailPanel');
    panel.classList.remove('detail-panel--open');
    setTimeout(() => { panel.style.display = 'none'; }, 250);
}

document.getElementById('detailPanel').addEventListener('click', function(e) {
    if (e.target === this) closeDetail();
});

async function loadAnalyst() {
    const btn = document.getElementById('analystRefresh');
    const tbody = document.getElementById('analystBody');
    btn.classList.add('spinning');
    tbody.innerHTML = `<tr><td colspan="5" class="analyst-placeholder">
        <div class="spinner spinner--sm"></div> Actualizando...
    </td></tr>`;

    try {
        const resp = await fetch(`${APP_BASE}/api/analyst`);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        renderAnalyst(data);
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" class="analyst-placeholder">Error al cargar datos.</td></tr>`;
        console.error('Analyst error:', e);
    } finally {
        btn.classList.remove('spinning');
    }
}

// ═══════════════════════════════════════════════════════════════
// SIGNALS
// ═══════════════════════════════════════════════════════════════

let signalsData = null;

function timeAgoStr(dateStr) {
    const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 60) return 'ahora';
    if (diff < 3600) return Math.floor(diff / 60) + 'min';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    return Math.floor(diff / 86400) + 'd';
}

function renderSignals(data) {
    signalsData = data;
    const list = document.getElementById('signalsList');
    document.getElementById('signalsUpdated').textContent =
        'Actualizado: ' + new Date(data.calculated_at).toLocaleTimeString('es-ES');

    if (!data.signals || data.signals.length === 0) {
        list.innerHTML = `<div class="signals-empty">
            <div class="signals-empty__icon">\u{1F4CA}</div>
            <div>No hay señales activas en este momento</div>
            <div class="aave-empty__sub">Las señales se generan automáticamente</div>
        </div>`;
        return;
    }

    let html = '';
    for (let idx = 0; idx < data.signals.length; idx++) {
        const sig = data.signals[idx];
        const st = sig.style || {};
        const dec = ['BTC', 'ETH'].includes(sig.coin) ? 2 : (sig.coin === 'SOL' ? 3 : 4);
        const priceStr = Number(sig.price).toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });
        const scoreBar = Math.min(100, sig.score);
        const barColor = sig.signal_type.includes('buy') ? '#22c55e' : (sig.signal_type.includes('sell') ? '#ef4444' : '#6b7280');
        const timeAgo = timeAgoStr(sig.created_at);

        html += `<div class="signal-card" style="border-left:4px solid ${st.color || '#6b7280'}" onclick="showSignalDetail(${idx})">
            <div class="signal-card__top">
                <div class="signal-card__coin"><strong>${sig.coin}</strong> <span class="signal-card__tf">${sig.timeframe}</span></div>
                <div class="signal-card__badge" style="background:${st.bg};color:${st.color}">${st.emoji} ${st.label}</div>
            </div>
            <div class="signal-card__score-wrap">
                <div class="signal-card__score-bar">
                    <div class="signal-card__score-fill" style="width:${scoreBar}%;background:${barColor}"></div>
                </div>
                <span class="signal-card__score-num">${sig.score}</span>
            </div>
            <div class="signal-card__bottom">
                <span>${priceStr} $</span>
                <span>${timeAgo}</span>
            </div>
            ${sig.reasons && sig.reasons.length ? `<div class="signal-card__reason">${sig.reasons[0]}</div>` : ''}
        </div>`;
    }
    list.innerHTML = html;
}

function showSignalDetail(idx) {
    if (!signalsData || !signalsData.signals[idx]) return;
    const sig = signalsData.signals[idx];
    const st = sig.style || {};
    const dec = ['BTC', 'ETH'].includes(sig.coin) ? 2 : (sig.coin === 'SOL' ? 3 : 4);

    document.getElementById('sigDetailHeader').innerHTML = `<strong>${sig.coin}</strong> ${sig.timeframe}`;
    document.getElementById('sigDetailScore').innerHTML =
        `<span style="color:${st.color}">${st.emoji} ${st.label}</span> — Score: <strong>${sig.score}/100</strong>`;

    if (sig.current_phase) {
        const ps = sig.phase_style || {};
        document.getElementById('sigDetailPhase').innerHTML =
            `Fase actual: <span style="color:${ps.color}">${ps.emoji} ${sig.current_phase}</span>`;
        document.getElementById('sigDetailPhase').style.display = '';
    } else {
        document.getElementById('sigDetailPhase').style.display = 'none';
    }

    document.getElementById('sigDetailPrice').innerHTML =
        `Precio: <strong>${Number(sig.price).toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec })} $</strong>`;

    if (sig.sma20_distance !== null && sig.sma20_distance !== undefined) {
        const sign = sig.sma20_distance >= 0 ? '+' : '';
        document.getElementById('sigDetailSMA').innerHTML =
            `Distancia a SMA20: <strong>${sign}${sig.sma20_distance.toFixed(2)}%</strong>`;
        document.getElementById('sigDetailSMA').style.display = '';
    } else {
        document.getElementById('sigDetailSMA').style.display = 'none';
    }

    let levelsHtml = '';
    if (sig.nearest_support) levelsHtml += `Soporte: <strong>${Number(sig.nearest_support).toLocaleString('es-ES', { maximumFractionDigits: dec })} $</strong> `;
    if (sig.nearest_resist) levelsHtml += `Resistencia: <strong>${Number(sig.nearest_resist).toLocaleString('es-ES', { maximumFractionDigits: dec })} $</strong>`;
    document.getElementById('sigDetailLevels').innerHTML = levelsHtml || 'S/R: —';

    const wyEl = document.getElementById('sigDetailWyckoff');
    if (sig.wyckoff_pattern) {
        wyEl.innerHTML = `Patrón Wyckoff: <strong>${sig.wyckoff_pattern === 'spring' ? '\u{1F7E2} Spring' : '\u{1F534} Upthrust'}</strong>`;
        wyEl.style.display = '';
    } else {
        wyEl.style.display = 'none';
    }

    const reasonsEl = document.getElementById('sigDetailReasons');
    if (sig.reasons && sig.reasons.length) {
        reasonsEl.innerHTML = '<div class="signal-detail__reasons-title">Razones:</div>' +
            sig.reasons.map(r => `<div class="signal-detail__reason-item">• ${r}</div>`).join('');
    } else {
        reasonsEl.innerHTML = '';
    }

    document.getElementById('sigDetailTime').textContent = 'Generada: ' + new Date(sig.created_at).toLocaleString('es-ES');

    const panel = document.getElementById('signalDetail');
    panel.style.display = 'flex';
    panel.getBoundingClientRect();
    panel.classList.add('signal-detail--open');
}

function closeSignalDetail() {
    const panel = document.getElementById('signalDetail');
    panel.classList.remove('signal-detail--open');
    setTimeout(() => { panel.style.display = 'none'; }, 250);
}

document.getElementById('signalDetail').addEventListener('click', function(e) {
    if (e.target === this) closeSignalDetail();
});

async function loadSignals() {
    const btn = document.getElementById('signalsRefresh');
    const list = document.getElementById('signalsList');
    btn.classList.add('spinning');
    list.innerHTML = `<div class="signals-placeholder"><div class="spinner spinner--sm"></div> Actualizando...</div>`;

    try {
        const resp = await fetch(`${APP_BASE}/api/signals?action=list`);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        renderSignals(data);
    } catch (e) {
        list.innerHTML = `<div class="signals-placeholder">Error al cargar señales.</div>`;
        console.error('Signals error:', e);
    } finally {
        btn.classList.remove('spinning');
    }
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY — Delta-Neutral on Arbitrum
// ═══════════════════════════════════════════════════════════════

let strategyData = null;
let activeTracker = null;
let trackerCheckInterval = null;

function getDeviceToken() {
    let t = localStorage.getItem('defi_device_token');
    if (!t) { t = 'dev_' + Math.random().toString(36).slice(2, 10); localStorage.setItem('defi_device_token', t); }
    return t;
}

function fmtUsd(v) {
    if (v == null) return '—';
    return Number(v).toLocaleString('es-ES', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function fmtP(v) {
    if (!v || v === 0) return '—';
    if (v > 1000) return Number(v).toLocaleString('es-ES', { maximumFractionDigits: 0 });
    if (v > 1) return Number(v).toLocaleString('es-ES', { maximumFractionDigits: 2 });
    return Number(v).toLocaleString('es-ES', { maximumFractionDigits: 4 });
}

const RISK_COLORS = {
    bajo:        { bg: 'rgba(34,197,94,0.15)',  color: '#22c55e' },
    medio:       { bg: 'rgba(234,179,8,0.15)',  color: '#eab308' },
    'medio-alto':{ bg: 'rgba(249,115,22,0.15)', color: '#f97316' },
    alto:        { bg: 'rgba(239,68,68,0.15)',  color: '#ef4444' },
};

const STRATEGY_ICONS = {
    lp_stable: '\u{1F4B5}', aave_supply: '\u{1F3E6}', aave_loop: '\u{1F504}',
    funding_arb: '\u{1F4B0}', hedged_lp: '\u{1F6E1}', managed_lp: '\u{2699}',
};

async function loadStrategy() {
    const amount = parseFloat(document.getElementById('strategyAmount').value) || 10000;
    const btn = document.getElementById('strategyRefresh');
    const list = document.getElementById('strategyList');
    btn.classList.add('spinning');
    list.innerHTML = '<div class="strategy-empty"><div class="spinner spinner--sm"></div><div>Analizando mercado y generando estrategia...</div></div>';
    document.getElementById('strategyPortfolio').style.display = 'none';

    try {
        await fetchLivePrices();
        const btcP = latestPrices['BTCUSDT'] || 0;
        const ethP = latestPrices['ETHUSDT'] || 0;
        const resp = await fetch(`${APP_BASE}/api/strategy?amount=${amount}&btcPrice=${btcP}&ethPrice=${ethP}`);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        strategyData = data;
        renderStrategy(data);
    } catch (e) {
        list.innerHTML = `<div class="strategy-empty"><div style="color:var(--bear)">Error: ${e.message}</div></div>`;
    } finally {
        btn.classList.remove('spinning');
    }
}

function renderStrategy(data) {
    const src = document.getElementById('strategySources');
    src.style.display = '';
    src.innerHTML = `<span>BTC: ${data.btcPhase || 'N/A'}</span><span>ETH: ${data.ethPhase || 'N/A'}</span>`;

    // ── Portfolio summary ──
    const portfolio = document.getElementById('strategyPortfolio');
    portfolio.style.display = '';

    const marketColor = data.marketPhase === 'ALCISTA' ? 'var(--bull)' : (data.marketPhase === 'BAJISTA' ? 'var(--bear)' : 'var(--accent2)');

    document.getElementById('portfolioApy').textContent = data.totalEstApy + '% APY est.';
    document.getElementById('portfolioAllocations').innerHTML = `
        <div class="portfolio-alloc">
            <span class="portfolio-alloc__name">Mercado</span>
            <span style="color:${marketColor};font-weight:800;font-size:0.82rem">${data.marketPhase}</span>
        </div>
        <div class="portfolio-alloc">
            <span class="portfolio-alloc__name">Activo principal</span>
            <span style="font-weight:700">${data.mainAsset}</span>
        </div>
        <div class="portfolio-alloc">
            <span class="portfolio-alloc__name">Health Factor</span>
            <span style="color:${data.healthFactor > 1.5 ? 'var(--bull)' : 'var(--bear)'};font-weight:800">${data.healthFactor}</span>
        </div>
        <div class="portfolio-alloc">
            <span class="portfolio-alloc__name">Colateral</span>
            <span style="font-weight:700">${fmtUsd(data.totalExposure?.collateral)}</span>
        </div>
        <div class="portfolio-alloc">
            <span class="portfolio-alloc__name">Borrowed</span>
            <span style="font-weight:700">${fmtUsd(data.totalExposure?.borrowed)}</span>
        </div>
    `;

    // ── Steps ──
    const list = document.getElementById('strategyList');
    if (!data.steps?.length) {
        list.innerHTML = '<div class="strategy-empty"><div>No se pudo generar estrategia</div></div>';
        return;
    }

    // Load existing tracker data if any
    const tracked = activeTracker?.steps || [];
    const trackedMap = {};
    for (const t of tracked) trackedMap[t.step_num] = t;

    let html = '';

    // Alert banner
    html += '<div id="trackerAlerts"></div>';

    for (const s of data.steps) {
        const apyColor = s.apy >= 0 ? 'var(--bull)' : 'var(--bear)';
        const apySign = s.apy >= 0 ? '+' : '';
        const dirBadge = s.direction
            ? `<span class="strategy-step__dir strategy-step__dir--${s.direction === 'LONG' ? 'long' : 'short'}">${s.direction}</span>`
            : '';

        const t = trackedMap[s.step] || {};
        const isDone = t.done === 1;

        const hasLevels = s.entry_price || s.stop_loss || s.take_profit || s.liquidation || s.lp_range_low;

        let levelsHtml = '';
        if (hasLevels) {
            levelsHtml += '<div class="strategy-step__levels">';
            if (s.entry_price) levelsHtml += `<div class="step-level"><span class="step-level__label">Entrada</span><span class="step-level__val">$${fmtP(t.entry_price || s.entry_price)}</span></div>`;
            if (s.stop_loss) levelsHtml += `<div class="step-level step-level--sl"><span class="step-level__label">Stop Loss</span><span class="step-level__val">$${fmtP(s.stop_loss)}</span></div>`;
            if (s.take_profit) levelsHtml += `<div class="step-level step-level--tp"><span class="step-level__label">Take Profit</span><span class="step-level__val">$${fmtP(s.take_profit)}</span></div>`;
            if (s.liquidation) levelsHtml += `<div class="step-level step-level--liq"><span class="step-level__label">Liquidación</span><span class="step-level__val">$${fmtP(s.liquidation)}</span></div>`;
            if (s.lp_range_low) levelsHtml += `<div class="step-level step-level--range"><span class="step-level__label">Rango LP</span><span class="step-level__val">$${fmtP(s.lp_range_low)} — $${fmtP(s.lp_range_high)}</span></div>`;
            levelsHtml += '</div>';
        }

        // Editable inputs (always visible, pre-filled with strategy values)
        let inputsHtml = '<div class="strategy-step__inputs" id="step-inputs-' + s.step + '">';
        if (s.entry_price || s.direction || s.action?.includes('Borrow')) {
            inputsHtml += `<div class="step-input-row"><label>Precio entrada</label><input type="number" step="any" value="${t.entry_price || s.entry_price || ''}" onchange="updateStepField(${s.step}, 'entry_price', this.value)"></div>`;
        }
        if (s.lp_range_low || s.action?.includes('Pool') || s.action?.includes('LP')) {
            inputsHtml += `<div class="step-input-row"><label>Rango LP bajo</label><input type="number" step="any" value="${t.lp_range_low || s.lp_range_low || ''}" onchange="updateStepField(${s.step}, 'lp_range_low', this.value)"></div>`;
            inputsHtml += `<div class="step-input-row"><label>Rango LP alto</label><input type="number" step="any" value="${t.lp_range_high || s.lp_range_high || ''}" onchange="updateStepField(${s.step}, 'lp_range_high', this.value)"></div>`;
        }
        inputsHtml += '</div>';

        html += `<div class="strategy-step-card ${isDone ? 'strategy-step--done' : ''}" id="step-card-${s.step}">
            <div class="strategy-step__check">
                <label class="step-check">
                    <input type="checkbox" ${isDone ? 'checked' : ''} onchange="toggleStep(${s.step}, this.checked)">
                    <span class="step-check__mark">${isDone ? '✓' : s.step}</span>
                </label>
            </div>
            <div class="strategy-step__body">
                <div class="strategy-step__action">${s.action} ${dirBadge}</div>
                <div class="strategy-step__detail">${s.detail}</div>
                ${levelsHtml}
                <div class="strategy-step__meta">
                    <span class="strategy-step__protocol">${s.protocol}</span>
                    <span class="strategy-step__amount">${fmtUsd(s.amount)}</span>
                    <span style="color:${apyColor};font-weight:800">${apySign}${s.apy?.toFixed(1) || '0'}% APY</span>
                </div>
                ${inputsHtml}
                ${isDone && t.executed_at ? `<div class="strategy-step__executed">✓ Ejecutado ${new Date(t.executed_at).toLocaleString('es-ES')}</div>` : ''}
            </div>
        </div>`;
    }

    // Warnings
    if (data.warnings?.length) {
        html += '<div class="strategy-warnings">';
        html += '<div class="strategy-warnings__title">Riesgos y advertencias</div>';
        for (const w of data.warnings) {
            html += `<div class="strategy-warnings__item">${w}</div>`;
        }
        html += '</div>';
    }

    // Rates used
    if (data.rates_source) {
        const r = data.rates_source;
        html += `<div class="strategy-rates">
            <div class="strategy-rates__title">Tasas utilizadas</div>
            <div class="strategy-rates__grid">
                <span>Aave Supply USDC</span><span>${r.aave_supply_usdc?.toFixed(1)}%</span>
                <span>Aave Borrow ETH</span><span>${r.aave_borrow_eth?.toFixed(1)}%</span>
                <span>Aave Borrow BTC</span><span>${r.aave_borrow_btc?.toFixed(1)}%</span>
                <span>LP ETH-USDC</span><span>${r.lp_eth_usdc?.toFixed(1)}%</span>
                <span>LP BTC-USDC</span><span>${r.lp_btc_usdc?.toFixed(1)}%</span>
                ${r.funding_eth != null ? `<span>Funding ETH</span><span>${(r.funding_eth * 100).toFixed(4)}%/h</span>` : ''}
                ${r.funding_btc != null ? `<span>Funding BTC</span><span>${(r.funding_btc * 100).toFixed(4)}%/h</span>` : ''}
            </div>
        </div>`;
    }

    html += `<div style="font-size:0.62rem;color:var(--text-3);text-align:center;margin-top:16px;font-style:italic">
        APYs estimados — verificar en DeFiLlama y protocolos antes de ejecutar. ${data.calculated_at ? new Date(data.calculated_at).toLocaleString('es-ES') : ''}
    </div>`;

    // Save button
    html += `<div style="margin-top:16px">
        <button class="btn-primary" onclick="saveAndTrackStrategy()" id="saveStrategyBtn">Guardar Estrategia</button>
    </div>`;

    // History section
    html += `<div id="strategyHistory" style="margin-top:20px"></div>`;

    list.innerHTML = html;
    loadStrategyHistory();
}

// ── Tracker functions ──

async function saveTrackerStrategy() {
    if (!strategyData) return;
    const dt = getDeviceToken();
    try {
        const resp = await fetch(`${APP_BASE}/api/tracker/save`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_token: dt,
                amount: strategyData.amount,
                market_phase: strategyData.marketPhase,
                main_asset: strategyData.mainAsset,
                strategy_json: strategyData,
                steps: strategyData.steps.map(s => ({
                    step_num: s.step, leverage: s.leverage, direction: s.direction, margin_amount: s.amount,
                })),
            }),
        });
        const data = await resp.json();
        if (data.ok) activeTracker = { strategy: { id: data.strategy_id }, steps: [], alerts: [] };
    } catch (_) {}
}

async function loadTracker() {
    const dt = getDeviceToken();
    try {
        const resp = await fetch(`${APP_BASE}/api/tracker?device_token=${dt}`);
        const data = await resp.json();
        if (data.ok && data.strategy) {
            activeTracker = data;
        }
    } catch (_) {}
}

async function toggleStep(stepNum, done) {
    if (!activeTracker?.strategy?.id) {
        await saveTrackerStrategy();
    }
    if (!activeTracker?.strategy?.id) return;

    const card = document.getElementById('step-card-' + stepNum);
    const inputs = document.getElementById('step-inputs-' + stepNum);
    if (card) card.classList.toggle('strategy-step--done', done);
    if (inputs) inputs.style.display = done ? '' : 'none';

    try {
        await fetch(`${APP_BASE}/api/tracker/step`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ strategy_id: activeTracker.strategy.id, step_num: stepNum, done }),
        });
    } catch (_) {}
}

async function updateStepField(stepNum, field, value) {
    if (!activeTracker?.strategy?.id) return;
    const body = { strategy_id: activeTracker.strategy.id, step_num: stepNum };
    body[field] = parseFloat(value) || null;
    try {
        await fetch(`${APP_BASE}/api/tracker/step`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (_) {}
}

async function checkTrackerAlerts() {
    if (!activeTracker?.strategy?.id) return;
    const dt = getDeviceToken();
    let priceParam = '';
    const mainAsset = strategyData?.mainAsset || 'ETH';
    const pairKey = mainAsset + 'USDT';
    if (latestPrices[pairKey]) priceParam = `&price=${latestPrices[pairKey]}`;

    try {
        const resp = await fetch(`${APP_BASE}/api/tracker/check?device_token=${dt}${priceParam}`);
        const data = await resp.json();
        if (!data.ok || !data.alerts?.length) {
            document.getElementById('trackerAlerts').innerHTML = '';
            return;
        }

        document.getElementById('trackerAlerts').innerHTML = data.alerts.map(a => {
            const color = a.alert_type === 'lp_out_of_range' ? 'var(--bear)' : 'var(--dist)';
            return `<div class="tracker-alert" style="border-left-color:${color}">
                <div class="tracker-alert__msg">${a.message}</div>
                <button class="tracker-alert__dismiss" onclick="dismissAlert(${a.id})">OK</button>
            </div>`;
        }).join('');
    } catch (_) {}
}

async function dismissAlert(id) {
    try {
        await fetch(`${APP_BASE}/api/tracker/dismiss`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alert_id: id }),
        });
        checkTrackerAlerts();
    } catch (_) {}
}

// Load tracker on strategy page load and start alert checking
async function initTracker() {
    await loadTracker();
    if (activeTracker?.strategy) {
        strategyData = activeTracker.strategy.strategy_json;
        if (strategyData?.steps) renderStrategy(strategyData);
    }
    if (trackerCheckInterval) clearInterval(trackerCheckInterval);
    trackerCheckInterval = setInterval(checkTrackerAlerts, 30000);
    loadRulesPanel();
}

async function saveAndTrackStrategy() {
    if (!strategyData) return;
    const btn = document.getElementById('saveStrategyBtn');
    btn.textContent = 'Guardando...';
    btn.disabled = true;

    await saveTrackerStrategy();

    btn.textContent = 'Guardada';
    btn.style.background = 'rgba(34,197,94,0.2)';
    btn.style.color = 'var(--bull)';
    setTimeout(() => {
        btn.textContent = 'Guardar Estrategia';
        btn.style.background = '';
        btn.style.color = '';
        btn.disabled = false;
    }, 2000);

    loadStrategyHistory();
}

async function loadStrategyHistory() {
    const el = document.getElementById('strategyHistory');
    if (!el) return;
    const dt = getDeviceToken();

    try {
        const resp = await fetch(`${APP_BASE}/api/tracker/history?device_token=${dt}`);
        const data = await resp.json();
        if (!data.ok || !data.strategies?.length) {
            el.innerHTML = '';
            return;
        }

        let html = '<div class="strategy-history">';
        html += '<div class="strategy-history__title">Historial de Estrategias</div>';

        for (const s of data.strategies) {
            const statusBadge = s.status === 'active'
                ? '<span class="history-badge history-badge--active">ACTIVA</span>'
                : '<span class="history-badge history-badge--closed">CERRADA</span>';
            const progress = s.steps_total > 0 ? `${s.steps_done}/${s.steps_total} pasos` : '';
            const date = new Date(s.created_at).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

            html += `<div class="history-card">
                <div class="history-card__top" onclick="loadHistoryStrategy(${s.id})">
                    <span class="history-card__amount">${fmtUsd(s.amount)}</span>
                    ${statusBadge}
                </div>
                <div class="history-card__mid" onclick="loadHistoryStrategy(${s.id})">
                    <span>${s.main_asset || '—'}</span>
                    <span class="history-card__phase">${s.market_phase || '—'}</span>
                    <span>${progress}</span>
                </div>
                <div class="history-card__bottom">
                    <span class="history-card__date">${date}</span>
                    <button class="history-card__delete" onclick="event.stopPropagation();deleteStrategy(${s.id})">Eliminar</button>
                </div>
            </div>`;
        }

        html += '</div>';
        el.innerHTML = html;
    } catch (_) {}
}

async function deleteStrategy(id) {
    try {
        const resp = await fetch(`${APP_BASE}/api/tracker/${id}`, { method: 'DELETE' });
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error);
        if (activeTracker?.strategy?.id === id) activeTracker = null;
        loadStrategyHistory();
    } catch (e) {
        console.error('Delete error:', e);
    }
}

async function loadHistoryStrategy(id) {
    try {
        const resp = await fetch(`${APP_BASE}/api/tracker/${id}`);
        const data = await resp.json();
        if (!data.ok || !data.strategy) return;

        activeTracker = data;
        strategyData = data.strategy.strategy_json;
        if (strategyData?.steps) renderStrategy(strategyData);

        document.querySelector('.page-content')?.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (_) {}
}

document.getElementById('strategyAmount').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadStrategy();
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS — Browser Notifications + Telegram
// ═══════════════════════════════════════════════════════════════

let notifPermission = Notification?.permission || 'default';
let notifCheckInterval = null;
const notifSeen = new Set();

async function requestNotifPermission() {
    if (!('Notification' in window)) return 'denied';
    notifPermission = await Notification.requestPermission();
    return notifPermission;
}

function showBrowserNotif(alert) {
    if (notifPermission !== 'granted') return;
    const icons = { critical: '🚨', action: '⚡', warning: '⚠️' };
    const icon = icons[alert.type] || '📋';
    const n = new Notification(`${icon} DeFi Alert`, {
        body: alert.message,
        tag: (alert.category || '') + '-' + (alert.asset || ''),
        renotify: alert.type === 'critical',
        silent: alert.type !== 'critical',
    });
    n.onclick = () => { window.focus(); n.close(); };
}

async function pollAlerts() {
    try {
        const resp = await fetch(`${APP_BASE}/api/rules/check?device=${getDeviceToken()}`);
        const data = await resp.json();
        if (!data.alerts) return;

        const actionable = data.alerts.filter(a => a.type !== 'info');
        for (const a of actionable) {
            const key = `${a.category}:${a.asset}:${a.type}`;
            if (notifSeen.has(key)) continue;
            notifSeen.add(key);
            showBrowserNotif(a);
            setTimeout(() => notifSeen.delete(key), a.type === 'critical' ? 900000 : 3600000);
        }

        renderLiveAlerts(data.alerts);
    } catch (_) {}
}

function startNotifPolling() {
    if (notifCheckInterval) clearInterval(notifCheckInterval);
    notifCheckInterval = setInterval(pollAlerts, 60000);
    pollAlerts();
}

async function checkNotifyStatus() {
    try {
        const resp = await fetch(`${APP_BASE}/api/notify/status`);
        return await resp.json();
    } catch (_) { return null; }
}

async function testTelegram() {
    const btn = document.getElementById('testTelegramBtn');
    if (btn) { btn.textContent = 'Enviando...'; btn.disabled = true; }
    try {
        const resp = await fetch(`${APP_BASE}/api/notify/telegram/test`, { method: 'POST' });
        const data = await resp.json();
        if (btn) { btn.textContent = data.ok ? '✓ Enviado' : '✗ Error'; }
    } catch (_) {
        if (btn) btn.textContent = '✗ Error';
    }
    setTimeout(() => { if (btn) { btn.textContent = 'Test Telegram'; btn.disabled = false; }}, 3000);
}

async function setupTelegram() {
    const tokenInput = document.getElementById('tgTokenInput');
    const btn = document.getElementById('setupTelegramBtn');
    const statusEl = document.getElementById('tgSetupStatus');
    const token = tokenInput?.value?.trim();
    if (!token) { if (statusEl) statusEl.textContent = 'Pega el token del bot'; return; }

    if (btn) { btn.textContent = 'Configurando...'; btn.disabled = true; }
    try {
        const resp = await fetch(`${APP_BASE}/api/notify/telegram/setup`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bot_token: token }),
        });
        const data = await resp.json();
        if (data.ok) {
            localStorage.setItem('defi_tg_token', token);
            if (statusEl) statusEl.innerHTML = `<span style="color:var(--bull)">✓ Conectado (chat: ${data.chat_id})</span>`;
            if (btn) { btn.textContent = '✓ Listo'; }
            loadRulesPanel();
        } else {
            localStorage.setItem('defi_tg_token', token);
            if (statusEl) statusEl.innerHTML = `<span style="color:var(--dist)">${data.message}</span>`;
            if (btn) { btn.textContent = 'Detectar'; btn.disabled = false; btn.onclick = detectTelegramChat; }
        }
    } catch (_) {
        if (statusEl) statusEl.textContent = 'Error de conexión';
        if (btn) { btn.textContent = 'Reintentar'; btn.disabled = false; }
    }
}

async function detectTelegramChat() {
    const btn = document.getElementById('setupTelegramBtn');
    const statusEl = document.getElementById('tgSetupStatus');
    if (btn) { btn.textContent = 'Detectando...'; btn.disabled = true; }
    try {
        const resp = await fetch(`${APP_BASE}/api/notify/telegram/detect`, { method: 'POST' });
        const data = await resp.json();
        if (data.ok) {
            if (statusEl) statusEl.innerHTML = `<span style="color:var(--bull)">✓ Conectado (chat: ${data.chat_id})</span>`;
            if (btn) { btn.textContent = '✓ Listo'; }
            loadRulesPanel();
        } else {
            if (statusEl) statusEl.innerHTML = `<span style="color:var(--dist)">${data.message}</span>`;
            if (btn) { btn.textContent = 'Detectar'; btn.disabled = false; }
        }
    } catch (_) {
        if (statusEl) statusEl.textContent = 'Error';
        if (btn) { btn.textContent = 'Reintentar'; btn.disabled = false; }
    }
}

async function enableBrowserNotifs() {
    const btn = document.getElementById('enableNotifBtn');
    if (btn) { btn.textContent = 'Activando...'; btn.disabled = true; }
    const perm = await requestNotifPermission();
    const ok = perm === 'granted';
    if (ok) {
        localStorage.setItem('defi_notif_enabled', '1');
        startNotifPolling();
        showBrowserNotif({ type: 'info', message: 'Notificaciones activadas. Recibirás alertas aquí.', category: 'test', asset: 'SYS' });
    }
    if (btn) {
        btn.textContent = ok ? '✓ Notificaciones ON' : '✗ Bloqueado por el navegador';
        btn.style.background = ok ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)';
        btn.style.color = ok ? 'var(--bull)' : 'var(--bear)';
    }
}

async function forceCheckRules() {
    const btn = document.getElementById('forceCheckBtn');
    if (btn) { btn.textContent = 'Checkeando...'; btn.disabled = true; }
    try {
        const resp = await fetch(`${APP_BASE}/api/rules/check?device=${getDeviceToken()}`);
        const data = await resp.json();
        if (data.alerts) {
            renderLiveAlerts(data.alerts);
            const actionable = data.alerts.filter(a => a.type !== 'info');
            if (actionable.length && notifPermission === 'granted') {
                for (const a of actionable) showBrowserNotif(a);
            }
        }
    } catch (_) {}
    setTimeout(() => { if (btn) { btn.textContent = 'Checkear ahora'; btn.disabled = false; }}, 2000);
}

function renderLiveAlerts(alerts) {
    const el = document.getElementById('liveAlerts');
    if (!el) return;
    if (!alerts.length) {
        el.innerHTML = '<div class="live-alerts__empty">Sin alertas activas</div>';
        return;
    }

    const icons = { critical: '🚨', action: '⚡', warning: '⚠️', info: 'ℹ️' };
    const colors = { critical: 'var(--bear)', action: 'var(--accent)', warning: 'var(--dist)', info: 'var(--text-3)' };

    el.innerHTML = alerts.map(a => {
        const icon = icons[a.type] || '📋';
        const color = colors[a.type] || 'var(--text-2)';
        let actionsHtml = '';
        if (a.actions?.length) {
            actionsHtml = '<div class="live-alert__actions">' + a.actions.map(ac => `<div class="live-alert__action-item">→ ${ac}</div>`).join('') + '</div>';
        }
        return `<div class="live-alert" style="border-left: 3px solid ${color}">
            <div class="live-alert__header">
                <span class="live-alert__icon">${icon}</span>
                <span class="live-alert__msg">${a.message}</span>
            </div>
            ${actionsHtml}
        </div>`;
    }).join('');
}

async function loadRulesPanel() {
    const el = document.getElementById('rulesPanel');
    if (!el) return;

    const status = await checkNotifyStatus();
    let tgOk = status?.telegram?.configured;
    const cronOk = status?.cron?.running;
    const notifOn = notifPermission === 'granted';

    // Auto-restore Telegram config if lost (e.g. after DB reset on deploy)
    if (!tgOk && localStorage.getItem('defi_tg_token')) {
        try {
            const resp = await fetch(`${APP_BASE}/api/notify/telegram/setup`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bot_token: localStorage.getItem('defi_tg_token') }),
            });
            const data = await resp.json();
            if (data.ok) tgOk = true;
        } catch (_) {}
    }

    let html = '<div class="rules-panel">';

    // Status badges
    html += '<div class="rules-status">';
    html += `<span class="rules-badge ${cronOk ? 'rules-badge--on' : 'rules-badge--off'}">Cron ${cronOk ? 'ON' : 'OFF'}</span>`;
    html += `<span class="rules-badge ${tgOk ? 'rules-badge--on' : 'rules-badge--off'}">Telegram ${tgOk ? '✓' : '✗'}</span>`;
    html += `<span class="rules-badge ${notifOn ? 'rules-badge--on' : 'rules-badge--off'}">Notif ${notifOn ? '✓' : '✗'}</span>`;
    html += '</div>';

    // Telegram setup
    if (!tgOk) {
        html += '<div class="tg-setup">';
        html += '<div class="tg-setup__title">Configurar Telegram</div>';
        html += '<div class="tg-setup__steps">';
        html += '<div class="tg-setup__step">1. Abre <b>@BotFather</b> en Telegram → /newbot o usa tu bot existente</div>';
        html += '<div class="tg-setup__step">2. Manda <b>/start</b> a tu bot (@Defijuan_bot)</div>';
        html += '<div class="tg-setup__step">3. Pega el token aquí abajo:</div>';
        html += '</div>';
        html += '<div class="tg-setup__input-row">';
        html += '<input type="text" class="tg-setup__input" id="tgTokenInput" placeholder="123456:ABC-DEF..." spellcheck="false">';
        html += '<button class="rules-btn rules-btn--accent" id="setupTelegramBtn" onclick="setupTelegram()">Conectar</button>';
        html += '</div>';
        html += '<div class="tg-setup__status" id="tgSetupStatus"></div>';
        html += '</div>';
    }

    // Action buttons
    html += '<div class="rules-actions">';
    if (!notifOn) html += '<button class="rules-btn" id="enableNotifBtn" onclick="enableBrowserNotifs()">Activar Notificaciones</button>';
    if (tgOk) html += '<button class="rules-btn" id="testTelegramBtn" onclick="testTelegram()">Test Telegram</button>';
    html += '<button class="rules-btn rules-btn--accent" id="forceCheckBtn" onclick="forceCheckRules()">Checkear ahora</button>';
    html += '</div>';

    // Live alerts container
    html += '<div id="liveAlerts" class="live-alerts"><div class="live-alerts__empty">Pulsa "Checkear ahora" para ver alertas</div></div>';

    // Rules reference
    html += '<details class="rules-reference"><summary class="rules-reference__title">Reglas de entrada/salida</summary>';
    html += '<div class="rules-reference__content">';

    try {
        const resp = await fetch(`${APP_BASE}/api/rules`);
        const rules = await resp.json();

        html += '<div class="rules-section"><div class="rules-section__title">Reglas de Entrada</div>';
        for (const [key, rule] of Object.entries(rules.entry_rules)) {
            const phaseColors = { bull: 'var(--bull)', bear: 'var(--bear)', accumulation: 'var(--accent)', distribution: 'var(--dist)' };
            html += `<div class="rule-card" style="border-left: 3px solid ${phaseColors[key] || 'var(--text-3)'}">`;
            html += `<div class="rule-card__name">${rule.name}</div>`;
            html += '<div class="rule-card__conditions">';
            for (const c of rule.conditions) html += `<div class="rule-card__cond">✓ ${c}</div>`;
            html += '</div>';
            html += '<div class="rule-card__actions">';
            for (const a of rule.actions) html += `<div class="rule-card__act">→ ${a.desc}</div>`;
            html += '</div></div>';
        }
        html += '</div>';

        html += '<div class="rules-section"><div class="rules-section__title">Reglas de Salida</div>';
        for (const [, rule] of Object.entries(rules.exit_rules)) {
            const prioColors = { critical: 'var(--bear)', action: 'var(--accent)', warning: 'var(--dist)' };
            html += `<div class="rule-card" style="border-left: 3px solid ${prioColors[rule.priority] || 'var(--text-3)'}">`;
            html += `<div class="rule-card__name">${rule.name}</div>`;
            html += `<div class="rule-card__trigger">Trigger: ${rule.trigger}</div>`;
            html += '<div class="rule-card__actions">';
            for (const a of rule.actions) html += `<div class="rule-card__act">→ ${a}</div>`;
            html += '</div></div>';
        }
        html += '</div>';
    } catch (_) {
        html += '<div>Error cargando reglas</div>';
    }

    html += '</div></details></div>';
    el.innerHTML = html;

    if (notifOn) startNotifPolling();
}

// ═══════════════════════════════════════════════════════════════
// AUTO-UPDATE — Check for new version every 60s
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// SIMULATOR
// ═══════════════════════════════════════════════════════════════

async function runSimulation() {
    const amount = parseFloat(document.getElementById('simAmount').value) || 10000;
    const asset = document.getElementById('simAsset').value;
    const startDate = document.getElementById('simStartDate').value;
    if (!startDate) { alert('Selecciona fecha de inicio'); return; }

    document.getElementById('simLoading').style.display = 'flex';
    document.getElementById('simResults').style.display = 'none';
    document.getElementById('simLog').style.display = 'none';

    try {
        const resp = await fetch(`${APP_BASE}/api/simulator?asset=${asset}&amount=${amount}&startDate=${startDate}`);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        renderSimResults(data);
    } catch (e) {
        document.getElementById('simResults').style.display = '';
        document.getElementById('simResults').innerHTML = `<div class="strategy-warnings"><div class="strategy-warnings__title">Error</div><div class="strategy-warnings__item">${e.message}</div></div>`;
    } finally {
        document.getElementById('simLoading').style.display = 'none';
    }
}

function renderSimResults(data) {
    const el = document.getElementById('simResults');
    el.style.display = '';

    const retColor = data.totalReturn >= 0 ? 'var(--bull)' : 'var(--bear)';
    const bhColor = data.buyHoldReturn >= 0 ? 'var(--bull)' : 'var(--bear)';
    const alphaColor = data.alpha >= 0 ? 'var(--bull)' : 'var(--bear)';

    el.innerHTML = `
        <div class="strategy-portfolio-card" style="margin-top:14px">
            <div style="text-align:center;margin-bottom:12px">
                <div style="font-size:2.2rem;font-weight:900;color:${retColor}">${data.totalReturn >= 0 ? '+' : ''}${data.totalReturn}%</div>
                <div style="font-size:0.75rem;color:var(--text-3)">Retorno estrategia</div>
            </div>
            <div class="portfolio-alloc">
                <span class="portfolio-alloc__name">Capital inicial</span>
                <span style="font-weight:700">${fmtUsd(data.initialAmount)}</span>
            </div>
            <div class="portfolio-alloc">
                <span class="portfolio-alloc__name">Capital final</span>
                <span style="font-weight:800;color:${retColor}">${fmtUsd(data.finalValue)}</span>
            </div>
            <div class="portfolio-alloc">
                <span class="portfolio-alloc__name">Buy & Hold</span>
                <span style="font-weight:700;color:${bhColor}">${data.buyHoldReturn >= 0 ? '+' : ''}${data.buyHoldReturn}%</span>
            </div>
            <div class="portfolio-alloc">
                <span class="portfolio-alloc__name">Alpha vs B&H</span>
                <span style="font-weight:800;color:${alphaColor}">${data.alpha >= 0 ? '+' : ''}${data.alpha}%</span>
            </div>
            <div class="portfolio-alloc">
                <span class="portfolio-alloc__name">Período</span>
                <span style="font-weight:600">${data.startDate} → ${data.endDate} (${data.totalDays}d)</span>
            </div>
            <div class="portfolio-alloc">
                <span class="portfolio-alloc__name">Cambios de etapa</span>
                <span style="font-weight:700">${data.phaseChanges}</span>
            </div>
            <div class="portfolio-alloc">
                <span class="portfolio-alloc__name">LP Take Profit (salida arriba)</span>
                <span style="font-weight:700;color:var(--bull)">${data.lpExitTop || 0}</span>
            </div>
            <div class="portfolio-alloc">
                <span class="portfolio-alloc__name">LP Exit Bottom</span>
                <span style="font-weight:700;color:var(--bear)">${data.lpExitBottom || 0}</span>
            </div>
            <div class="portfolio-alloc">
                <span class="portfolio-alloc__name">LP Auto-USDC</span>
                <span style="font-weight:700;color:var(--accent2)">${data.lpAutoUsdc || 0}</span>
            </div>
            <div class="portfolio-alloc">
                <span class="portfolio-alloc__name">Liquidaciones</span>
                <span style="font-weight:700;color:${data.liquidations > 0 ? 'var(--bear)' : 'var(--bull)'}">${data.liquidations}</span>
            </div>
        </div>

        <button class="btn-secondary" style="width:100%;margin-top:10px;padding:12px" onclick="toggleSimLog()">
            Ver Log Completo (${data.log?.length || 0} eventos)
        </button>

        <button class="btn-secondary" style="width:100%;margin-top:8px;padding:12px" onclick="copySimLog()">
            Copiar Log al Portapapeles
        </button>
    `;

    // Render log
    const logEl = document.getElementById('simLog');
    if (data.log?.length) {
        let logHtml = '<div class="sim-log">';
        logHtml += '<div class="sim-log__title">Log de Simulación</div>';
        for (const entry of data.log) {
            const typeColors = { phase_change: 'var(--accent2)', open: 'var(--bull)', close: 'var(--bear)', liquidation: 'var(--bear)', lp_rebalance: 'var(--dist)', lp_exit_top: 'var(--bull)', lp_exit_bottom: 'var(--bear)', lp_auto_usdc: 'var(--accent2)', lp_remount: 'var(--bull)', phase_adjust: 'var(--accent2)', adjust_close: 'var(--text-2)', end: 'var(--text-2)', cooldown: 'var(--text-3)' };
            const color = typeColors[entry.type] || 'var(--text-3)';
            logHtml += `<div class="sim-log__entry">
                <span class="sim-log__date">${entry.date}</span>
                <span class="sim-log__type" style="color:${color}">${entry.type}</span>
                <span class="sim-log__msg">${entry.message}</span>
            </div>`;
        }
        logHtml += '</div>';
        logEl.innerHTML = logHtml;
        window._simLogData = data.log;
    }
}

function toggleSimLog() {
    const el = document.getElementById('simLog');
    el.style.display = el.style.display === 'none' ? '' : 'none';
}

function copySimLog() {
    if (!window._simLogData) return;
    const text = window._simLogData.map(e => `${e.date} [${e.type}] ${e.message}`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
        alert('Log copiado al portapapeles');
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        alert('Log copiado');
    });
}

// ═══════════════════════════════════════════════════════════════
// AUTO-UPDATE
// ═══════════════════════════════════════════════════════════════

let currentBuild = null;
let updateAvailable = false;

async function checkVersion() {
    try {
        const r = await fetch(`${APP_BASE}/api/version`, { cache: 'no-store' });
        if (!r.ok) return;
        const data = await r.json();

        if (currentBuild === null) {
            currentBuild = data.build;
            return;
        }

        if (data.build !== currentBuild && !updateAvailable) {
            updateAvailable = true;
            document.getElementById('updateBanner').style.display = 'flex';

            if ('serviceWorker' in navigator) {
                const reg = await navigator.serviceWorker.getRegistration();
                if (reg) {
                    reg.update();
                    if (reg.waiting) reg.waiting.postMessage('skipWaiting');
                }
            }
        }
    } catch (_) {}
}

function applyUpdate() {
    document.getElementById('updateBanner').style.display = 'none';
    if ('caches' in window) {
        caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
    }
    location.reload(true);
}

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
        reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (newWorker) {
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'activated' && currentBuild !== null) {
                        checkVersion();
                    }
                });
            }
        });
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (updateAvailable) location.reload();
    });
}

// ═══════════════════════════════════════════════════════════════
// OPERATIVA DIARIA
// ═══════════════════════════════════════════════════════════════

let dtWatchInterval = null;
let dtWatchAssets = [];
let dtWatchCount = 0;
const DT_WATCH_INTERVAL_MS = 3 * 60 * 1000;
const DT_WATCH_MAX_HOURS = 6;
const DT_ALL_ASSETS = ['ETH', 'BTC', 'SOL'];
let dtOpenSignals = [];
let dtTrackInterval = null;

async function analyzeDayTrade() {
    const checks = document.querySelectorAll('.dt-asset-check:checked');
    const assets = checks.length ? Array.from(checks).map(c => c.value) : ['ETH'];
    const btn = document.getElementById('dtAnalyzeBtn');
    const result = document.getElementById('dtResult');
    const loading = document.getElementById('dtLoading');

    btn.disabled = true; btn.textContent = 'Analizando...';
    result.innerHTML = '';
    loading.style.display = 'flex';

    try {
        const results = await Promise.all(assets.map(async a => {
            const resp = await fetch(`${APP_BASE}/api/daytrader?asset=${a}`);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return resp.json();
        }));
        renderDayTradeMulti(results);
    } catch (e) {
        result.innerHTML = `<div class="strategy-warnings"><div class="strategy-warnings__item">${e.message}</div></div>`;
    } finally {
        loading.style.display = 'none';
        btn.disabled = false; btn.textContent = 'Analizar';
    }
}

async function toggleDtWatch() {
    if (dtWatchInterval) {
        stopDtWatch();
        return;
    }

    if (notifPermission !== 'granted') {
        const perm = await requestNotifPermission();
        if (perm !== 'granted') {
            const wb = document.getElementById('dtWatchBtn');
            if (wb) { wb.textContent = 'Permite notificaciones primero'; setTimeout(() => { wb.textContent = 'Avisarme'; }, 2500); }
            return;
        }
    }

    const checks = document.querySelectorAll('.dt-asset-check:checked');
    dtWatchAssets = checks.length ? Array.from(checks).map(c => c.value) : DT_ALL_ASSETS;
    dtWatchCount = 0;
    const maxChecks = Math.floor(DT_WATCH_MAX_HOURS * 60 / (DT_WATCH_INTERVAL_MS / 60000));

    const wb = document.getElementById('dtWatchBtn');
    if (wb) { wb.textContent = `Vigilando ${dtWatchAssets.join(', ')}...`; wb.classList.add('dt-watch-btn--active'); }
    updateWatchStatus(`Vigilando ${dtWatchAssets.join(', ')}. Chequeo cada 3 min (max ${DT_WATCH_MAX_HOURS}h).`);

    localStorage.setItem('defi_dt_watch', JSON.stringify({ assets: dtWatchAssets, started: Date.now() }));

    fetch(`${APP_BASE}/api/daytrader/watch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assets: dtWatchAssets, action: 'start' }),
    }).catch(() => {});

    dtWatchInterval = setInterval(async () => {
        dtWatchCount++;
        if (dtWatchCount > maxChecks) { stopDtWatch(); return; }
        await dtWatchCheck();
    }, DT_WATCH_INTERVAL_MS);

    dtWatchCheck();
}

async function dtWatchCheck() {
    try {
        const time = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        updateWatchStatus(`Vigilando ${dtWatchAssets.join(', ')}... (#${dtWatchCount} - ${time})`);

        const results = await Promise.all(dtWatchAssets.map(async a => {
            const resp = await fetch(`${APP_BASE}/api/daytrader?asset=${a}`);
            if (!resp.ok) return null;
            return resp.json();
        }));

        const valid = results.filter(Boolean);
        const signals = valid.filter(d => d.signal === 'LONG' || d.signal === 'SHORT');

        renderDayTradeMulti(valid);

        for (const data of signals) {
            showBrowserNotif({
                type: 'critical',
                message: `${data.signal} ${data.asset} — TP $${fmtP(data.tp)} / SL $${fmtP(data.sl)}`,
                category: 'daytrader', asset: data.asset,
            });

            fetch(`${APP_BASE}/api/daytrader/watch`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset: data.asset, action: 'signal', trade: data, device_token: getDeviceToken() }),
            }).catch(() => {});
        }

        if (signals.length) {
            updateWatchStatus(`${signals.map(s => s.signal + ' ' + s.asset).join(', ')} encontrado. Alerta enviada.`);
        }
    } catch (_) {}
}

function stopDtWatch() {
    if (dtWatchInterval) { clearInterval(dtWatchInterval); dtWatchInterval = null; }
    const wb = document.getElementById('dtWatchBtn');
    if (wb) { wb.textContent = 'Avisarme cuando haya señal'; wb.classList.remove('dt-watch-btn--active'); }
    dtWatchAssets = [];
    dtWatchCount = 0;
    localStorage.removeItem('defi_dt_watch');

    fetch(`${APP_BASE}/api/daytrader/watch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
    }).catch(() => {});
}

function restoreDtWatch() {
    const saved = localStorage.getItem('defi_dt_watch');
    if (!saved) return;
    try {
        const { assets, started } = JSON.parse(saved);
        const elapsed = Date.now() - started;
        if (elapsed > DT_WATCH_MAX_HOURS * 60 * 60 * 1000) {
            localStorage.removeItem('defi_dt_watch');
            return;
        }
        dtWatchAssets = assets;
        dtWatchCount = Math.floor(elapsed / DT_WATCH_INTERVAL_MS);
        const maxChecks = Math.floor(DT_WATCH_MAX_HOURS * 60 / (DT_WATCH_INTERVAL_MS / 60000));

        const wb = document.getElementById('dtWatchBtn');
        if (wb) { wb.textContent = `Vigilando ${dtWatchAssets.join(', ')}...`; wb.classList.add('dt-watch-btn--active'); }
        updateWatchStatus(`Restaurado. Vigilando ${dtWatchAssets.join(', ')} (#${dtWatchCount}).`);

        dtWatchInterval = setInterval(async () => {
            dtWatchCount++;
            if (dtWatchCount > maxChecks) { stopDtWatch(); return; }
            await dtWatchCheck();
        }, DT_WATCH_INTERVAL_MS);

        dtWatchCheck();
    } catch (_) { localStorage.removeItem('defi_dt_watch'); }
}

function updateWatchStatus(msg) {
    const el = document.getElementById('dtWatchStatus');
    if (el) el.textContent = msg;
}

function renderDayTradeMulti(trades) {
    const el = document.getElementById('dtResult');
    let html = '';

    // Active tracking
    html += '<div id="dtActiveTracking"></div>';

    // Watch button
    const isWatching = !!dtWatchInterval;
    html += `<div class="dt-watch-row">
        <button class="dt-watch-btn ${isWatching ? 'dt-watch-btn--active' : ''}" id="dtWatchBtn" onclick="toggleDtWatch()">
            ${isWatching ? 'Vigilando ' + dtWatchAssets.join(', ') + '...' : 'Avisarme cuando haya señal'}
        </button>
        <div class="dt-watch-status" id="dtWatchStatus">${isWatching ? 'Vigilando...' : 'Vigila las monedas seleccionadas. Te avisa por Telegram + notificación.'}</div>
    </div>`;

    // Sort: signals first
    const sorted = [...trades].sort((a, b) => {
        const aSignal = (a.signal === 'LONG' || a.signal === 'SHORT') ? 1 : 0;
        const bSignal = (b.signal === 'LONG' || b.signal === 'SHORT') ? 1 : 0;
        if (aSignal !== bSignal) return bSignal - aSignal;
        return Math.abs(b.score || 0) - Math.abs(a.score || 0);
    });

    for (const d of sorted) {
        html += renderSingleTrade(d);
    }

    // History section
    html += '<div id="dtHistory"></div>';

    el.innerHTML = html;
    loadDtHistory();
    loadOpenTrades();
}

async function loadDtHistory() {
    const el = document.getElementById('dtHistory');
    if (!el) return;
    const dt = getDeviceToken();
    try {
        const resp = await fetch(`${APP_BASE}/api/daytrader/history?device_token=${dt}&limit=20`);
        const data = await resp.json();
        if (!data.ok || !data.signals?.length) { el.innerHTML = ''; return; }

        dtOpenSignals = data.signals.filter(s => s.status === 'open');

        let html = '<div class="dt-history">';
        html += '<div class="dt-history__title">Historial de operaciones</div>';

        // Stats
        const s = data.stats;
        html += `<div class="dt-history__stats">
            <span>Total: <b>${s.total}</b></span>
            <span>Abiertas: <b>${s.open}</b></span>
            <span style="color:var(--bull)">TP: <b>${s.wins}</b></span>
            <span style="color:var(--bear)">SL: <b>${s.losses}</b></span>
            <span>Win rate: <b>${s.winRate}%</b></span>
        </div>`;

        for (const sig of data.signals) {
            const isOpen = sig.status === 'open';
            const dirColor = sig.signal === 'LONG' ? 'var(--bull)' : 'var(--bear)';
            const resultBadge = sig.result === 'tp' ? '<span class="dt-h-badge dt-h-badge--tp">TP</span>'
                : sig.result === 'sl' ? '<span class="dt-h-badge dt-h-badge--sl">SL</span>'
                : sig.result === 'manual' ? '<span class="dt-h-badge dt-h-badge--manual">MANUAL</span>'
                : sig.result === 'expired' ? '<span class="dt-h-badge dt-h-badge--expired">EXPIRADO</span>'
                : '';
            const date = new Date(sig.created_at).toLocaleString('es-ES', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });

            html += `<div class="dt-h-card ${isOpen ? 'dt-h-card--open' : ''}">
                <div class="dt-h-card__top">
                    <span class="dt-h-card__dir" style="color:${dirColor}">${sig.signal} ${sig.asset}</span>
                    ${isOpen ? '<span class="dt-h-badge dt-h-badge--open">ABIERTA</span>' : resultBadge}
                </div>
                <div class="dt-h-card__mid">
                    <span>$${fmtP(sig.entry_price)}</span>
                    <span style="color:var(--bull)">TP $${fmtP(sig.tp)}</span>
                    <span style="color:var(--bear)">SL $${fmtP(sig.sl)}</span>
                    <span>x${sig.leverage} R:R ${sig.rr}</span>
                </div>
                <div class="dt-h-card__bottom">
                    <span class="dt-h-card__date">${date}</span>
                    ${sig.pnl_pct ? `<span style="color:${sig.pnl_pct >= 0 ? 'var(--bull)' : 'var(--bear)'}">${sig.pnl_pct >= 0 ? '+' : ''}${sig.pnl_pct.toFixed(1)}%</span>` : ''}
                    ${isOpen ? `<div class="dt-h-card__close-btns">
                        <button class="dt-h-close dt-h-close--tp" onclick="closeDtSignal(${sig.id},'tp')">TP</button>
                        <button class="dt-h-close dt-h-close--sl" onclick="closeDtSignal(${sig.id},'sl')">SL</button>
                        <button class="dt-h-close" onclick="closeDtSignal(${sig.id},'manual')">Cerrar</button>
                    </div>` : ''}
                </div>
            </div>`;
        }
        html += '</div>';
        el.innerHTML = html;
    } catch (_) {}
}

async function closeDtSignal(id, result) {
    const sig = dtOpenSignals.find(s => s.id === id);
    let pnl = 0;
    let closeP = 0;
    if (sig) {
        try {
            const pair = sig.asset + 'USDT';
            if (latestPrices[pair]) {
                closeP = latestPrices[pair];
                if (sig.signal === 'LONG') pnl = ((closeP - sig.entry_price) / sig.entry_price * sig.leverage * 100);
                else pnl = ((sig.entry_price - closeP) / sig.entry_price * sig.leverage * 100);
            }
        } catch (_) {}
    }
    await fetch(`${APP_BASE}/api/daytrader/close`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, result, closed_price: closeP, pnl_pct: +pnl.toFixed(2) }),
    });
    clearTradeBackup(id);
    loadDtHistory();
    loadOpenTrades();
}

function showEnterForm(tradeJson) {
    const d = typeof tradeJson === 'string' ? JSON.parse(tradeJson) : tradeJson;
    const el = document.getElementById('dtEnterForm-' + d.asset);
    if (!el) return;
    el.style.display = el.style.display === 'none' ? '' : 'none';
}

async function confirmEntry(asset) {
    const entryP = parseFloat(document.getElementById('dtEntry-' + asset)?.value);
    const tp = parseFloat(document.getElementById('dtTp-' + asset)?.value);
    const sl = parseFloat(document.getElementById('dtSl-' + asset)?.value);
    const lev = parseInt(document.getElementById('dtLev-' + asset)?.value) || 3;
    const margin = parseFloat(document.getElementById('dtMargin-' + asset)?.value) || 0;
    const signalDir = document.getElementById('dtDir-' + asset)?.value;
    const signalId = document.getElementById('dtSigId-' + asset)?.value;

    if (!entryP || !tp || !sl) return;

    // Save to DB first if no ID yet
    let id = signalId;
    if (!id || id === 'new') {
        const resp = await fetch(`${APP_BASE}/api/daytrader/save`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_token: getDeviceToken(),
                trade: { asset, signal: signalDir, confidence: 'manual', score: 0, entry: entryP, tp, sl, rr: 0, leverage: lev, liqPrice: 0, maxHoldHours: 6, exitBy: new Date(Date.now() + 6*3600000).toISOString() },
            }),
        });
        const data = await resp.json();
        id = data.id;
    }

    await fetch(`${APP_BASE}/api/daytrader/enter`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, entry_price: entryP, tp, sl, leverage: lev, margin, signal: signalDir, asset }),
    });

    const backed = getBackedUpTrades();
    backed.push({ id, asset, signal: signalDir, entry_price: entryP, tp, sl, leverage: lev, exit_by: new Date(Date.now() + 6*3600000).toISOString() });
    backupOpenTrades(backed);

    startTradeTracking();
    loadDtHistory();
    loadOpenTrades();

    const form = document.getElementById('dtEnterForm-' + asset);
    if (form) form.innerHTML = '<div style="color:var(--bull);font-size:0.75rem;font-weight:700;padding:8px;text-align:center">✓ Entrada confirmada — vigilando TP/SL</div>';
}

function startTradeTracking() {
    if (dtTrackInterval) return;
    dtTrackInterval = setInterval(checkTrackedTrades, 30000);
    localStorage.setItem('defi_dt_tracking', '1');
    checkTrackedTrades();
}

function stopTradeTracking() {
    if (dtTrackInterval) { clearInterval(dtTrackInterval); dtTrackInterval = null; }
    localStorage.removeItem('defi_dt_tracking');
}

async function checkTrackedTrades() {
    try {
        const resp = await fetch(`${APP_BASE}/api/daytrader/check-tracking`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_token: getDeviceToken() }),
        });
        const data = await resp.json();
        if (!data.ok || !data.alerts?.length) return;

        for (const a of data.alerts) {
            if (a.type === 'tp' || a.type === 'sl') {
                const icon = a.type === 'tp' ? '✅' : '❌';
                showBrowserNotif({ type: 'critical', message: `${icon} ${a.message}`, category: 'dt-track', asset: a.asset });

                await fetch(`${APP_BASE}/api/daytrader/close`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: a.id, result: a.type, closed_price: a.price, pnl_pct: +a.pnlPct.toFixed(2) }),
                });
                loadDtHistory();
            } else if (a.type === 'near_tp' || a.type === 'near_sl') {
                showBrowserNotif({ type: 'action', message: a.message, category: 'dt-near-' + a.type, asset: a.asset });
            } else if (a.type === 'expired' || a.type === 'expiring') {
                showBrowserNotif({ type: 'warning', message: a.message, category: 'dt-expire', asset: a.asset });
            }
        }

        // Check if still tracking anything
        const trackResp = await fetch(`${APP_BASE}/api/daytrader/tracking?device_token=${getDeviceToken()}`);
        const trackData = await trackResp.json();
        if (!trackData.trades?.length) stopTradeTracking();

        renderActiveTracking(trackData.trades || []);
    } catch (_) {}
}

function renderActiveTracking(trades) {
    const el = document.getElementById('dtActiveTracking');
    if (!el) return;
    if (!trades.length) { el.innerHTML = ''; return; }

    let html = '<div class="dt-tracking"><div class="dt-tracking__title">Operaciones activas</div>';
    for (const t of trades) {
        const pair = t.asset + 'USDT';
        const price = latestPrices[pair] || 0;
        const isLong = t.signal === 'LONG';
        const pnl = price ? (isLong ? (price - t.entry_price) / t.entry_price * t.leverage * 100 : (t.entry_price - price) / t.entry_price * t.leverage * 100) : 0;
        const pnlColor = pnl >= 0 ? 'var(--bull)' : 'var(--bear)';
        const dirColor = isLong ? 'var(--bull)' : 'var(--bear)';

        const totalRange = Math.abs(t.tp - t.sl);
        const distToTp = Math.abs(price - t.tp);
        const tpPct = totalRange > 0 ? Math.max(0, Math.min(100, (1 - distToTp / totalRange) * 100)) : 0;

        html += `<div class="dt-track-card">
            <div class="dt-track-card__top">
                <span style="color:${dirColor};font-weight:800">${t.signal} ${t.asset}</span>
                <span style="color:${pnlColor};font-weight:800;font-size:0.9rem">${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%</span>
            </div>
            <div class="dt-track-card__bar">
                <div class="dt-track-card__fill" style="width:${tpPct}%;background:${pnlColor}"></div>
            </div>
            <div class="dt-track-card__levels">
                <span style="color:var(--bear)">SL $${fmtP(t.sl)}</span>
                <span>$${fmtP(price)}</span>
                <span style="color:var(--bull)">TP $${fmtP(t.tp)}</span>
            </div>
            <div class="dt-track-card__meta">
                <span>Entrada: $${fmtP(t.entry_price)}</span>
                <span>x${t.leverage}</span>
                <button class="dt-h-close" onclick="closeDtSignal(${t.id},'manual')">Cerrar</button>
            </div>
        </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
}

async function addManualTrade() {
    const asset = document.getElementById('dtManualAsset').value;
    const signal = document.getElementById('dtManualDir').value;
    const entry = parseFloat(document.getElementById('dtManualEntry').value);
    const tp = parseFloat(document.getElementById('dtManualTp').value);
    const sl = parseFloat(document.getElementById('dtManualSl').value);
    const lev = parseInt(document.getElementById('dtManualLev').value) || 3;
    const margin = parseFloat(document.getElementById('dtManualMargin').value) || 0;

    if (!entry || !tp || !sl) { alert('Rellena entrada, TP y SL'); return; }

    const resp = await fetch(`${APP_BASE}/api/daytrader/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            device_token: getDeviceToken(),
            trade: { asset, signal, confidence: 'manual', score: 0, entry, tp, sl, rr: 0, leverage: lev, liqPrice: 0, maxHoldHours: 6, exitBy: new Date(Date.now() + 6*3600000).toISOString() },
        }),
    });
    const data = await resp.json();
    if (!data.ok) return;

    await fetch(`${APP_BASE}/api/daytrader/enter`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: data.id, entry_price: entry, tp, sl, leverage: lev, margin, signal, asset }),
    });

    document.getElementById('dtManualEntry').value = '';
    document.getElementById('dtManualTp').value = '';
    document.getElementById('dtManualSl').value = '';
    document.getElementById('dtManualMargin').value = '';
    document.getElementById('dtAddManual').open = false;

    startTradeTracking();
    loadOpenTrades();
}

// ── Trade backup/restore (survives DB wipe on deploy) ──

function backupOpenTrades(trades) {
    if (!trades?.length) return;
    localStorage.setItem('defi_open_trades', JSON.stringify(trades));
}

function getBackedUpTrades() {
    try {
        const raw = localStorage.getItem('defi_open_trades');
        return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
}

function clearTradeBackup(id) {
    const trades = getBackedUpTrades().filter(t => t.id !== id);
    if (trades.length) localStorage.setItem('defi_open_trades', JSON.stringify(trades));
    else localStorage.removeItem('defi_open_trades');
}

async function restoreTradesIfNeeded() {
    const dt = getDeviceToken();
    try {
        const resp = await fetch(`${APP_BASE}/api/daytrader/tracking?device_token=${dt}`);
        const data = await resp.json();
        if (data.ok && data.trades?.length) {
            backupOpenTrades(data.trades);
            return;
        }
    } catch (_) {}

    const backed = getBackedUpTrades();
    if (!backed.length) return;

    console.log(`[DT] Restoring ${backed.length} trades from backup`);
    for (const t of backed) {
        try {
            const resp = await fetch(`${APP_BASE}/api/daytrader/save`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_token: dt,
                    trade: { asset: t.asset, signal: t.signal, confidence: t.confidence || 'restored', score: t.score || 0, entry: t.entry_price, tp: t.tp, sl: t.sl, rr: t.rr || 0, leverage: t.leverage, liqPrice: t.liq_price || 0, maxHoldHours: t.max_hold_hours || 6, exitBy: t.exit_by || new Date(Date.now() + 6*3600000).toISOString() },
                }),
            });
            const saved = await resp.json();
            if (saved.ok) {
                await fetch(`${APP_BASE}/api/daytrader/enter`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: saved.id, entry_price: t.entry_price, tp: t.tp, sl: t.sl, leverage: t.leverage, signal: t.signal, asset: t.asset }),
                });
            }
        } catch (_) {}
    }
    startTradeTracking();
}

async function loadOpenTrades() {
    const el = document.getElementById('dtOpenTrades');
    if (!el) return;
    const dt = getDeviceToken();

    try {
        const resp = await fetch(`${APP_BASE}/api/daytrader/tracking?device_token=${dt}`);
        const data = await resp.json();
        if (!data.ok || !data.trades?.length) {
            el.innerHTML = '';
            localStorage.removeItem('defi_open_trades');
            return;
        }

        backupOpenTrades(data.trades);

        let html = '<div class="dt-open-section"><div class="dt-open-section__title">Operaciones abiertas</div>';

        for (const t of data.trades) {
            const pair = t.asset + 'USDT';
            const price = latestPrices[pair] || 0;
            const isLong = t.signal === 'LONG';
            const dirColor = isLong ? 'var(--bull)' : 'var(--bear)';
            const pnl = price ? (isLong ? (price - t.entry_price) / t.entry_price * t.leverage * 100 : (t.entry_price - price) / t.entry_price * t.leverage * 100) : 0;
            const pnlColor = pnl >= 0 ? 'var(--bull)' : 'var(--bear)';

            const totalRange = Math.abs(t.tp - t.sl);
            const distToTp = price ? Math.abs(price - t.tp) : totalRange;
            const pctToTp = totalRange > 0 ? Math.max(0, Math.min(100, (1 - distToTp / totalRange) * 100)) : 0;

            const exitTime = t.exit_by ? new Date(t.exit_by) : null;
            const remaining = exitTime ? Math.max(0, exitTime.getTime() - Date.now()) : 0;
            const minsLeft = Math.round(remaining / 60000);
            const timeStr = minsLeft > 60 ? `${Math.floor(minsLeft/60)}h ${minsLeft%60}m` : `${minsLeft}m`;

            html += `<div class="dt-open-card">
                <div class="dt-open-card__header">
                    <span class="dt-open-card__dir" style="color:${dirColor}">${t.signal} ${t.asset}</span>
                    <span class="dt-open-card__pnl" style="color:${pnlColor}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%</span>
                </div>
                <div class="dt-open-card__bar">
                    <div class="dt-open-card__fill" style="width:${pctToTp}%;background:${pnlColor}"></div>
                </div>
                <div class="dt-open-card__levels">
                    <span style="color:var(--bear)">SL $${fmtP(t.sl)}</span>
                    <span style="font-weight:700;color:var(--text-1)">${price ? '$' + fmtP(price) : '...'}</span>
                    <span style="color:var(--bull)">TP $${fmtP(t.tp)}</span>
                </div>
                <div class="dt-open-card__info">
                    <span>Entrada: $${fmtP(t.entry_price)}</span>
                    <span>x${t.leverage}</span>
                    ${remaining > 0 ? `<span>${timeStr} restante</span>` : '<span style="color:var(--dist)">Expirado</span>'}
                </div>
                <div class="dt-open-card__actions">
                    <button class="dt-h-close dt-h-close--tp" onclick="closeDtSignal(${t.id},'tp')">TP alcanzado</button>
                    <button class="dt-h-close dt-h-close--sl" onclick="closeDtSignal(${t.id},'sl')">SL tocado</button>
                    <button class="dt-h-close" onclick="closeDtSignal(${t.id},'manual')">Cerrar manual</button>
                </div>
            </div>`;
        }

        html += '</div>';
        el.innerHTML = html;

        if (!dtTrackInterval) startTradeTracking();
    } catch (_) {}
}

function renderSingleTrade(d) {
    const isLong = d.signal === 'LONG';
    const isShort = d.signal === 'SHORT';
    const isTrade = isLong || isShort;
    const dirColor = isLong ? 'var(--bull)' : isShort ? 'var(--bear)' : 'var(--text-3)';

    let html = '';

    if (isTrade) {
        const confColors = { alta: 'var(--bull)', media: 'var(--dist)', baja: 'var(--bear)' };
        html += `<div class="dt-signal" style="border-color: ${dirColor}">
            <div class="dt-signal__dir" style="color:${dirColor}">${d.signal} ${d.asset}</div>
            <div class="dt-signal__conf">Confianza: <span style="color:${confColors[d.confidence]}">${d.confidence.toUpperCase()}</span> (score ${d.score})</div>
            <div class="dt-signal__price">Entrada: <b>$${fmtP(d.entry)}</b></div>
            <div class="dt-levels">
                <div class="dt-level dt-level--tp">
                    <span class="dt-level__label">Take Profit</span>
                    <span class="dt-level__val">$${fmtP(d.tp)}</span>
                    <span class="dt-level__pct" style="color:var(--bull)">+${d.tpDistPct}%</span>
                </div>
                <div class="dt-level dt-level--sl">
                    <span class="dt-level__label">Stop Loss</span>
                    <span class="dt-level__val">$${fmtP(d.sl)}</span>
                    <span class="dt-level__pct" style="color:var(--bear)">-${d.slDistPct}%</span>
                </div>
                <div class="dt-level">
                    <span class="dt-level__label">R:R</span>
                    <span class="dt-level__val" style="color:${d.rr >= 2 ? 'var(--bull)' : 'var(--dist)'}">${d.rr}</span>
                    <span class="dt-level__pct"></span>
                </div>
            </div>
            <div class="dt-meta">
                <div>Leverage: <b>x${d.leverage}</b></div>
                <div>Liq: $${fmtP(d.liqPrice)}</div>
                <div>Ganancia: <span style="color:var(--bull)">${d.potentialPnl.win}</span> / Pérdida: <span style="color:var(--bear)">${d.potentialPnl.loss}</span></div>
            </div>
            <div class="dt-lev-warn">NO usar m&aacute;s de x${d.leverage}. Con x${d.leverage} el SL = ${d.slDistPct}% de p&eacute;rdida. Con x20 ser&iacute;a ${(d.slDistPct * 20 / d.leverage).toFixed(1)}%.</div>
            <div class="dt-timer">Cerrar antes de: <b>${new Date(d.exitBy).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</b> (${d.maxHoldHours}h max)</div>
            <button class="dt-enter-btn" onclick="showEnterForm('${d.asset}')">He entrado</button>
            <div class="dt-enter-form" id="dtEnterForm-${d.asset}" style="display:none">
                <input type="hidden" id="dtDir-${d.asset}" value="${d.signal}">
                <input type="hidden" id="dtSigId-${d.asset}" value="new">
                <div class="dt-enter-form__row">
                    <div><label>Entrada</label><input type="number" step="any" id="dtEntry-${d.asset}" value="${d.entry}" class="dt-enter-input"></div>
                    <div><label>TP</label><input type="number" step="any" id="dtTp-${d.asset}" value="${d.tp}" class="dt-enter-input"></div>
                </div>
                <div class="dt-enter-form__row">
                    <div><label>SL</label><input type="number" step="any" id="dtSl-${d.asset}" value="${d.sl}" class="dt-enter-input"></div>
                    <div><label>x Leverage</label><input type="number" id="dtLev-${d.asset}" value="${d.leverage}" class="dt-enter-input"></div>
                </div>
                <div class="dt-enter-form__row">
                    <div><label>Margen ($)</label><input type="number" step="any" id="dtMargin-${d.asset}" placeholder="18.11" class="dt-enter-input"></div>
                    <div><button class="dt-confirm-btn" onclick="confirmEntry('${d.asset}')">Confirmar entrada</button></div>
                </div>
            </div>
        </div>`;
    } else {
        html += `<div class="dt-signal dt-signal--no">
            <div class="dt-signal__header-no">${d.asset || '?'} <span style="font-weight:400;font-size:0.7rem;color:var(--text-3)">$${fmtP(d.price)}</span></div>
            <div class="dt-signal__dir" style="color:var(--text-3);font-size:1rem">NO OPERAR</div>
            <div class="dt-signal__reason">${d.reason}</div>
            ${d.rr ? `<div class="dt-signal__rr">R:R: ${d.rr.toFixed(2)}</div>` : ''}
        </div>`;
    }

    // Collapsible details
    html += `<details class="dt-details"><summary class="dt-details__summary">${d.asset || '?'} — Detalle análisis</summary>`;

    // Timeframe analysis
    html += '<div class="dt-analysis">';
    html += '<div class="dt-analysis__title">Análisis Multi-Timeframe</div>';

    const tfs = [
        { label: '6H', data: d.analysis.tf6h },
        { label: '1H', data: d.analysis.tf1h },
        { label: '15M', data: d.analysis.tf15m },
    ];

    for (const tf of tfs) {
        const biasColors = { bullish: 'var(--bull)', weakBullish: 'rgba(34,197,94,0.6)', neutral: 'var(--text-3)', weakBearish: 'rgba(239,68,68,0.6)', bearish: 'var(--bear)' };
        const biasLabels = { bullish: 'ALCISTA', weakBullish: 'ALCISTA DEBIL', neutral: 'LATERAL', weakBearish: 'BAJISTA DEBIL', bearish: 'BAJISTA' };
        const momLabels = { bullish: 'Comprador', neutral: 'Neutral', bearish: 'Vendedor' };

        html += `<div class="dt-tf">
            <div class="dt-tf__label">${tf.label}</div>
            <div class="dt-tf__bias" style="color:${biasColors[tf.data.bias]}">${biasLabels[tf.data.bias] || tf.data.bias}</div>
            <div class="dt-tf__details">
                <span>SMA20: $${fmtP(tf.data.sma20)}</span>
                <span>${tf.data.aboveSma ? 'Encima' : 'Debajo'} (${tf.data.distPct > 0 ? '+' : ''}${tf.data.distPct.toFixed(2)}%)</span>
                <span>Pendiente: ${tf.data.slope > 0 ? '+' : ''}${tf.data.slope.toFixed(2)}%</span>
                <span>Momento: ${momLabels[tf.data.momentum]}</span>
            </div>
        </div>`;
    }
    html += '</div>';

    // S/R Zones
    if (d.zones) {
        html += '<div class="dt-zones">';
        html += '<div class="dt-zones__title">Zonas S/R (1H)</div>';
        if (d.zones.resistances?.length) {
            html += '<div class="dt-zones__section"><span class="dt-zones__label" style="color:var(--bear)">Resistencias</span>';
            for (const r of d.zones.resistances) {
                html += `<div class="dt-zone dt-zone--resist">$${fmtP(r.price)} <span class="dt-zone__dist">+${r.distPct.toFixed(2)}%</span></div>`;
            }
            html += '</div>';
        }
        html += `<div class="dt-zones__price">$${fmtP(d.price)}</div>`;
        if (d.zones.supports?.length) {
            html += '<div class="dt-zones__section"><span class="dt-zones__label" style="color:var(--bull)">Soportes</span>';
            for (const s of d.zones.supports) {
                html += `<div class="dt-zone dt-zone--support">$${fmtP(s.price)} <span class="dt-zone__dist">-${s.distPct.toFixed(2)}%</span></div>`;
            }
            html += '</div>';
        }
        html += '</div>';
    }

    // Reasons
    if (d.reasons?.length) {
        html += '<div class="dt-reasons">';
        for (const r of d.reasons) {
            const isWarn = r.includes('PELIGRO') || r.includes('insuficiente');
            html += `<div class="dt-reason ${isWarn ? 'dt-reason--warn' : ''}">${r}</div>`;
        }
        html += '</div>';
    }

    html += '</details>';
    return html;
}

checkVersion();
setInterval(checkVersion, 60000);

// Auto-start notification polling if previously enabled
if (Notification?.permission === 'granted' && localStorage.getItem('defi_notif_enabled')) {
    startNotifPolling();
}

// Restore daytrader watch if it was running
restoreDtWatch();

// Restore trades + telegram config on app boot (any page)
restoreTradesIfNeeded();
if (localStorage.getItem('defi_tg_token')) {
    fetch(`${APP_BASE}/api/notify/status`).then(r => r.json()).then(s => {
        if (!s?.telegram?.configured) {
            fetch(`${APP_BASE}/api/notify/telegram/setup`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bot_token: localStorage.getItem('defi_tg_token') }),
            }).catch(() => {});
        }
    }).catch(() => {});
}
