const { fetchKlines, fetchAllPrices } = require('./binance');
const { sma, smaSlope, findMR, findmR } = require('./ranges');

// ═══════════════════════════════════════════════════════════════
// TIMEFRAME ANALYSIS
// ═══════════════════════════════════════════════════════════════

function analyzeTimeframe(candles, price) {
    const closes = candles.map(c => c.close);
    const sma20 = sma(closes, 20);
    const lastSma20 = sma20.filter(v => v !== null).pop();
    const slope = smaSlope(sma20, 5);
    const aboveSma = price > lastSma20;
    const distPct = ((price - lastSma20) / lastSma20) * 100;

    const last3 = candles.slice(-3);
    const bullCandles = last3.filter(c => c.close > c.open).length;
    const bearCandles = last3.filter(c => c.close < c.open).length;
    const momentum = bullCandles > bearCandles ? 'bullish' : bearCandles > bullCandles ? 'bearish' : 'neutral';

    let bias = 'neutral';
    if (aboveSma && slope > 0.1) bias = 'bullish';
    else if (!aboveSma && slope < -0.1) bias = 'bearish';
    else if (aboveSma && slope < -0.1) bias = 'weakBullish';
    else if (!aboveSma && slope > 0.1) bias = 'weakBearish';

    return { sma20: lastSma20, slope, aboveSma, distPct, bias, momentum };
}

// ═══════════════════════════════════════════════════════════════
// S/R ZONES FROM 1H CHART
// ═══════════════════════════════════════════════════════════════

function findZones(candles, price) {
    const mrs = findMR(candles);
    const mrs_low = findmR(candles);

    const resistances = mrs
        .filter(m => m.v > price)
        .sort((a, b) => a.v - b.v)
        .slice(0, 3);

    const supports = mrs_low
        .filter(m => m.v < price)
        .sort((a, b) => b.v - a.v)
        .slice(0, 3);

    const nearestResist = resistances[0]?.v || null;
    const nearestSupport = supports[0]?.v || null;

    const resistPct = nearestResist ? ((nearestResist - price) / price * 100) : null;
    const supportPct = nearestSupport ? ((price - nearestSupport) / price * 100) : null;

    return {
        resistances: resistances.map(r => ({ price: r.v, distPct: ((r.v - price) / price * 100) })),
        supports: supports.map(s => ({ price: s.v, distPct: ((price - s.v) / price * 100) })),
        nearestResist, nearestSupport, resistPct, supportPct,
    };
}

// ═══════════════════════════════════════════════════════════════
// TRADE SIGNAL GENERATOR
// ═══════════════════════════════════════════════════════════════

function generateTrade(price, asset, tf6h, tf1h, tf15m, zones) {
    const biasScores = { bullish: 2, weakBullish: 1, neutral: 0, weakBearish: -1, bearish: -2 };
    const momScores = { bullish: 1, neutral: 0, bearish: -1 };

    const score6h = biasScores[tf6h.bias] * 3;
    const score1h = biasScores[tf1h.bias] * 2 + momScores[tf1h.momentum];
    const score15m = biasScores[tf15m.bias] + momScores[tf15m.momentum] * 2;

    const totalScore = score6h + score1h + score15m;

    const reasons = [];

    // 6H context
    if (tf6h.bias === 'bullish') reasons.push(`6H alcista: precio sobre SMA20, pendiente +${tf6h.slope.toFixed(2)}%`);
    else if (tf6h.bias === 'bearish') reasons.push(`6H bajista: precio bajo SMA20, pendiente ${tf6h.slope.toFixed(2)}%`);
    else reasons.push(`6H lateral (${tf6h.bias})`);

    // 1H trend
    if (tf1h.bias === 'bullish') reasons.push(`1H alcista: SMA20 $${tf1h.sma20.toFixed(0)}, momento ${tf1h.momentum}`);
    else if (tf1h.bias === 'bearish') reasons.push(`1H bajista: SMA20 $${tf1h.sma20.toFixed(0)}, momento ${tf1h.momentum}`);
    else reasons.push(`1H ${tf1h.bias}: SMA20 $${tf1h.sma20.toFixed(0)}`);

    // 15M entry
    if (tf15m.momentum === 'bullish') reasons.push('15M: 3 últimas velas alcistas — momentum comprador');
    else if (tf15m.momentum === 'bearish') reasons.push('15M: 3 últimas velas bajistas — momentum vendedor');
    else reasons.push('15M: sin momentum claro');

    // Determine direction
    let direction = null;
    let confidence = 'baja';

    if (totalScore >= 6) { direction = 'LONG'; confidence = 'alta'; }
    else if (totalScore >= 3) { direction = 'LONG'; confidence = 'media'; }
    else if (totalScore <= -6) { direction = 'SHORT'; confidence = 'alta'; }
    else if (totalScore <= -3) { direction = 'SHORT'; confidence = 'media'; }
    else if (totalScore > 0) { direction = 'LONG'; confidence = 'baja'; }
    else if (totalScore < 0) { direction = 'SHORT'; confidence = 'baja'; }

    if (!direction) {
        return {
            signal: 'NO_TRADE',
            reason: 'Timeframes no alineados. Mejor esperar.',
            score: totalScore,
            analysis: { tf6h, tf1h, tf15m },
            zones,
            reasons,
        };
    }

    // S/R danger check
    if (direction === 'LONG' && zones.resistPct !== null && zones.resistPct < 0.3) {
        reasons.push(`PELIGRO: resistencia a solo ${zones.resistPct.toFixed(2)}% — sin espacio para LONG`);
        return {
            signal: 'NO_TRADE',
            reason: `Resistencia demasiado cerca ($${zones.nearestResist.toFixed(0)}, ${zones.resistPct.toFixed(2)}%). Esperar ruptura o retroceso.`,
            score: totalScore, analysis: { tf6h, tf1h, tf15m }, zones, reasons,
        };
    }
    if (direction === 'SHORT' && zones.supportPct !== null && zones.supportPct < 0.3) {
        reasons.push(`PELIGRO: soporte a solo ${zones.supportPct.toFixed(2)}% — sin espacio para SHORT`);
        return {
            signal: 'NO_TRADE',
            reason: `Soporte demasiado cerca ($${zones.nearestSupport.toFixed(0)}, ${zones.supportPct.toFixed(2)}%). Esperar ruptura o rebote.`,
            score: totalScore, analysis: { tf6h, tf1h, tf15m }, zones, reasons,
        };
    }

    // Calculate TP and SL
    let tp, sl, rr;

    if (direction === 'LONG') {
        tp = zones.nearestResist || price * 1.015;
        sl = zones.nearestSupport ? Math.max(zones.nearestSupport, price * 0.985) : price * 0.985;
        if (tf15m.aboveSma && tf1h.aboveSma) {
            sl = Math.max(sl, tf1h.sma20);
        }
        reasons.push(`TP: resistencia 1H en $${tp.toFixed(0)} (+${((tp - price) / price * 100).toFixed(2)}%)`);
        reasons.push(`SL: soporte 1H en $${sl.toFixed(0)} (-${((price - sl) / price * 100).toFixed(2)}%)`);
    } else {
        tp = zones.nearestSupport || price * 0.985;
        sl = zones.nearestResist ? Math.min(zones.nearestResist, price * 1.015) : price * 1.015;
        if (!tf15m.aboveSma && !tf1h.aboveSma) {
            sl = Math.min(sl, tf1h.sma20);
        }
        reasons.push(`TP: soporte 1H en $${tp.toFixed(0)} (-${((price - tp) / price * 100).toFixed(2)}%)`);
        reasons.push(`SL: resistencia 1H en $${sl.toFixed(0)} (+${((sl - price) / price * 100).toFixed(2)}%)`);
    }

    const reward = Math.abs(tp - price);
    const risk = Math.abs(price - sl);
    rr = risk > 0 ? (reward / risk) : 0;

    if (rr < 1.2) {
        reasons.push(`R:R ${rr.toFixed(2)} < 1.2 — riesgo/recompensa insuficiente`);
        return {
            signal: 'NO_TRADE',
            reason: `Ratio riesgo/recompensa ${rr.toFixed(2)} demasiado bajo (mínimo 1.2). Esperar mejor setup.`,
            score: totalScore, analysis: { tf6h, tf1h, tf15m }, zones, reasons, rr,
        };
    }

    // Leverage suggestion based on confidence + distance to SL
    const slDistPct = (risk / price) * 100;
    let leverage = 3;
    if (confidence === 'alta' && slDistPct > 0.5) leverage = 5;
    else if (confidence === 'alta') leverage = 7;
    else if (confidence === 'media' && slDistPct > 1) leverage = 3;
    else if (confidence === 'media') leverage = 5;
    else leverage = 3;

    const liqPrice = direction === 'LONG'
        ? price * (1 - 0.9 / leverage)
        : price * (1 + 0.9 / leverage);

    // Max hold time
    const maxHoldHours = 6;
    const exitTime = new Date(Date.now() + maxHoldHours * 60 * 60 * 1000).toISOString();

    return {
        signal: direction,
        asset,
        confidence,
        score: totalScore,
        entry: price,
        tp,
        sl,
        rr: +rr.toFixed(2),
        leverage,
        liqPrice,
        slDistPct: +slDistPct.toFixed(2),
        tpDistPct: +((reward / price) * 100).toFixed(2),
        maxHoldHours,
        exitBy: exitTime,
        potentialPnl: {
            win: `+${(reward / price * leverage * 100).toFixed(1)}%`,
            loss: `-${(risk / price * leverage * 100).toFixed(1)}%`,
        },
        analysis: { tf6h, tf1h, tf15m },
        zones,
        reasons,
    };
}

// ═══════════════════════════════════════════════════════════════
// MAIN — Analyze and generate trade
// ═══════════════════════════════════════════════════════════════

async function getDailyTrade(asset) {
    const pair = asset + 'USDT';
    const prices = await fetchAllPrices();
    const price = prices[pair];
    if (!price) throw new Error(`No price for ${pair}`);

    const [candles6h, candles1h, candles15m] = await Promise.all([
        fetchKlines(pair, '6h', 100),
        fetchKlines(pair, '1h', 250),
        fetchKlines(pair, '15m', 100),
    ]);

    const tf6h = analyzeTimeframe(candles6h, price);
    const tf1h = analyzeTimeframe(candles1h, price);
    const tf15m = analyzeTimeframe(candles15m, price);

    const zones = findZones(candles1h, price);

    const trade = generateTrade(price, asset, tf6h, tf1h, tf15m, zones);

    return {
        ...trade,
        pair,
        price,
        calculated_at: new Date().toISOString(),
    };
}

module.exports = { getDailyTrade };
