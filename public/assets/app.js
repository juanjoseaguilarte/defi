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
            if (page === 'aave') loadAavePosition();
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

    const supLevels = mrs_low.filter(m => m.v <= price);
    const resLevels = mrs.filter(m => m.v >= price);

    if (supLevels.length > 0) {
        sup = supLevels[supLevels.length - 1].v;
    } else {
        breakdown = true;
        sup = Math.min(...candles.slice(-10).map(c => c[2]));
    }

    if (resLevels.length > 0) {
        res = resLevels[0].v;
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

    const [dailyK, weeklyK, monthlyK] = await Promise.all([
        fetchBinanceKlines(symbol, '1d', 250),
        fetchBinanceKlines(symbol, '1w', 60),
        fetchBinanceKlines(symbol, '1M', 24),
    ]);

    const volumes = dailyK.map(k => parseFloat(k[3])); // using close as proxy
    const trend = clientDetectTrend(dailyK);

    return {
        pair,
        current_price: price,
        trend,
        vol_percentile: 50,
        daily: clientCalcRange(dailyK, price),
        weekly: clientCalcRange(weeklyK, price),
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
    range: '⚪', neutral: '⚫',
};

const TF_INTERVAL = { 'Mensual': 'M', 'Semanal': '10080', 'Diario': '1440', '6H': '360' };
const COIN_PAIR = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', UNI: 'UNIUSDT', JUP: 'JUPUSDT', AAVE: 'AAVEUSDT' };

let analystData = null;

function phaseShortLabel(type) {
    if (type === 'bull') return 'E2 Avance';
    if (type === 'bear') return 'E4 Declive';
    if (type === 'distribution') return 'E3 Distrib.';
    if (type === 'accumulation') return 'E1 Acum.';
    if (type === 'range') return 'Rango';
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
// AAVE
// ═══════════════════════════════════════════════════════════════

let aavePositionData = null;

function getDeviceToken() {
    let token = localStorage.getItem('defi_device_token');
    if (!token) {
        token = 'dev_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('defi_device_token', token);
    }
    return token;
}

function fmtUsd(v) {
    if (v == null) return '—';
    return Number(v).toLocaleString('es-ES', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function fmtQty(v, coin) {
    const dec = ['BTC'].includes(coin) ? 6 : (['ETH', 'SOL'].includes(coin) ? 4 : 2);
    return Number(v).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: dec });
}

async function loadAavePosition() {
    const dt = getDeviceToken();
    const btn = document.getElementById('aaveRefresh');
    btn?.classList.add('spinning');

    try {
        const resp = await fetch(`${APP_BASE}/api/aave?action=position&device_token=${encodeURIComponent(dt)}`);
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error);

        if (!data.position) {
            document.getElementById('aaveNoPosition').style.display = 'block';
            document.getElementById('aaveHasPosition').style.display = 'none';
            return;
        }

        aavePositionData = data;
        document.getElementById('aaveNoPosition').style.display = 'none';
        document.getElementById('aaveHasPosition').style.display = 'block';

        const pos = data.position;
        const live = data.live;
        const threshold = parseFloat(pos.hf_alert_threshold) || 1.80;

        const hfEl = document.getElementById('aaveHfCurrent');
        const hfBar = document.getElementById('aaveHfBar');
        const hfMarker = document.getElementById('aaveHfMarker');
        const hfStatus = document.getElementById('aaveHfStatus');

        document.getElementById('aaveHfThresholdDisplay').textContent = threshold.toFixed(2);
        document.getElementById('aaveHfThresholdEdit').value = threshold.toFixed(2);

        if (live.health_factor !== null) {
            const hf = live.health_factor;
            hfEl.textContent = hf.toFixed(2);

            if (hf > 2.5) {
                hfEl.className = 'aave-hf-hero__current aave-hf--safe';
                hfStatus.textContent = 'Posición segura';
                hfStatus.className = 'aave-hf-hero__status aave-hf--safe';
            } else if (hf > threshold) {
                hfEl.className = 'aave-hf-hero__current aave-hf--warning';
                hfStatus.textContent = 'Precaución — acercándose al umbral';
                hfStatus.className = 'aave-hf-hero__status aave-hf--warning';
            } else {
                hfEl.className = 'aave-hf-hero__current aave-hf--danger';
                hfStatus.textContent = 'PELIGRO — por debajo del umbral';
                hfStatus.className = 'aave-hf-hero__status aave-hf--danger';
            }

            const pct = Math.min(100, Math.max(0, ((hf - 1) / 4) * 100));
            hfBar.style.width = pct + '%';
            hfBar.style.background = hf > 2.5 ? 'var(--bull)' : (hf > threshold ? 'var(--dist)' : 'var(--bear)');

            const threshPct = Math.min(100, Math.max(0, ((threshold - 1) / 4) * 100));
            hfMarker.style.left = threshPct + '%';
        } else {
            hfEl.textContent = '—';
        }

        // Collateral
        const collAssets = data.collateral_assets || [];
        document.getElementById('aavePosCollList').innerHTML = collAssets.length
            ? collAssets.map(a => `<div class="aave-pos-row"><span class="aave-pos-label">${fmtQty(a.qty, a.coin)} ${a.coin}</span><span class="aave-pos-value">${fmtUsd(a.value_usd)}</span></div>`).join('')
            : '<div class="aave-pos-row"><span class="aave-pos-label">—</span></div>';
        document.getElementById('aavePosCollUsd').textContent = fmtUsd(live.collateral_usd);

        // Debt
        const debtAssets = data.debt_assets || [];
        document.getElementById('aavePosDebtList').innerHTML = debtAssets.length
            ? debtAssets.map(a => `<div class="aave-pos-row"><span class="aave-pos-label">${fmtQty(a.qty, a.coin)} ${a.coin}</span><span class="aave-pos-value">${fmtUsd(a.value_usd)}</span></div>`).join('')
            : '<div class="aave-pos-row"><span class="aave-pos-label">—</span></div>';
        document.getElementById('aavePosDebtUsd').textContent = fmtUsd(live.debt_usd);

        loadAaveActions();
    } catch (e) {
        console.error('Aave load error:', e);
    } finally {
        btn?.classList.remove('spinning');
    }
}

async function saveAavePosition() {
    const dt = getDeviceToken();
    const body = {
        action: 'save_position',
        device_token: dt,
        collateral_coin: document.getElementById('aaveCollCoin').value,
        collateral_qty: parseFloat(document.getElementById('aaveCollQty').value) || 0,
        debt_coin: document.getElementById('aaveDebtCoin').value,
        debt_qty: parseFloat(document.getElementById('aaveDebtQty').value) || 0,
        hf_alert_threshold: parseFloat(document.getElementById('aaveHfThreshold').value) || 1.80,
        notes: document.getElementById('aaveNotes').value,
    };

    try {
        const resp = await fetch(`${APP_BASE}/api/aave`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error);
        loadAavePosition();
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

function editAavePosition() {
    if (!aavePositionData?.position) return;
    const pos = aavePositionData.position;
    document.getElementById('aaveCollCoin').value = pos.collateral_coin;
    document.getElementById('aaveCollQty').value = pos.collateral_qty;
    document.getElementById('aaveDebtCoin').value = pos.debt_coin;
    document.getElementById('aaveDebtQty').value = pos.debt_qty;
    document.getElementById('aaveHfThreshold').value = pos.hf_alert_threshold || '1.80';
    document.getElementById('aaveNotes').value = pos.notes || '';
    document.getElementById('aaveNoPosition').style.display = 'block';
    document.getElementById('aaveHasPosition').style.display = 'none';
}

function showCloseConfirm() {
    document.getElementById('aaveCloseConfirm').style.display = 'block';
}
function cancelCloseConfirm() {
    document.getElementById('aaveCloseConfirm').style.display = 'none';
}

async function confirmClosePosition() {
    cancelCloseConfirm();
    const dt = getDeviceToken();
    try {
        const resp = await fetch(`${APP_BASE}/api/aave`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'close_position', device_token: dt }),
        });
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error);
    } catch (e) {
        console.error('Close position error:', e);
    }
    loadAavePosition();
}

async function saveHfThreshold() {
    const dt = getDeviceToken();
    const threshold = parseFloat(document.getElementById('aaveHfThresholdEdit').value);
    if (!threshold || threshold < 1 || threshold > 10) {
        alert('Introduce un valor entre 1.00 y 10.00');
        return;
    }

    try {
        const resp = await fetch(`${APP_BASE}/api/aave`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'update_hf_threshold', device_token: dt, hf_alert_threshold: threshold }),
        });
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error);

        document.getElementById('aaveHfThresholdDisplay').textContent = threshold.toFixed(2);
        const btn = document.getElementById('aaveHfSaveBtn');
        btn.textContent = 'Guardado';
        btn.style.background = 'rgba(34,197,94,0.2)';
        btn.style.color = 'var(--bull)';
        setTimeout(() => { btn.textContent = 'Guardar'; btn.style.background = ''; btn.style.color = ''; }, 2000);
        loadAavePosition();
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

async function loadAaveActions() {
    const dt = getDeviceToken();
    const el = document.getElementById('aaveActionsList');
    try {
        const resp = await fetch(`${APP_BASE}/api/aave?action=actions&device_token=${encodeURIComponent(dt)}`);
        const data = await resp.json();

        if (!data.actions || !data.actions.length) {
            el.innerHTML = '<div class="aave-timeline__empty">Sin acciones registradas</div>';
            return;
        }

        el.innerHTML = '<ul class="aave-timeline">' + data.actions.map(a => `
            <li class="aave-timeline__item">
                <div class="aave-timeline__dot"></div>
                <div>
                    <div class="aave-timeline__text">
                        <strong>${a.action_type}</strong>
                        ${a.from_asset ? `${a.from_asset} → ${a.to_asset}` : ''}
                        ${a.qty ? `(${a.qty})` : ''}
                    </div>
                    <div class="aave-timeline__time">${a.executed_at || a.created_at}</div>
                </div>
            </li>
        `).join('') + '</ul>';
    } catch (e) {
        el.innerHTML = '<div class="aave-timeline__empty">Error al cargar</div>';
    }
}

// ═══════════════════════════════════════════════════════════════
// AUTO-UPDATE — Check for new version every 60s
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

checkVersion();
setInterval(checkVersion, 60000);
