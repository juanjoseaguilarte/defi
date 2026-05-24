const { getDb } = require('../../db/init');
const { sma, findMR, findmR, smaSlope, detectTrainTracks } = require('./ranges');

const AAVE_LTV = { USDC: 0.80, ETH: 0.80, BTC: 0.73 };
const AAVE_BORROW_APY = { ETH: 3.2, BTC: 1.5 };
const LP_APY = { 'ETH-USDC': 25, 'BTC-USDC': 18 };

function detectPhaseFromCandles(candles, price) {
    if (candles.length < 45) return 'accumulation';
    const closes = candles.map(c => c.close);
    const sma20 = sma(closes, 20);
    const sma40 = sma(closes, 40);
    const last20 = sma20.filter(v => v !== null).pop();
    const last40 = sma40.filter(v => v !== null).pop();
    const slope20 = smaSlope(sma20, 5);
    const dist = ((price - last20) / last20) * 100;

    if (dist < -15) return 'bear';
    if (dist > 15) return 'bull';
    if (dist < -5) return slope20 < 0 ? 'bear' : 'distribution';
    if (dist > 5) return slope20 > 0 ? 'bull' : 'accumulation';

    const tracks = detectTrainTracks(sma20, sma40);
    if (tracks === 'up' && price > last20) return 'bull';
    if (tracks === 'down' && price < last20) return 'bear';
    if (last20 > last40) return price > last20 ? 'bull' : 'distribution';
    return price > last20 ? 'accumulation' : 'bear';
}

function runBacktest(candles, amount, asset) {
    const log = [];
    const dailyPnL = [];
    let cash = amount;
    let positions = { aave_supply: 0, aave_borrow: 0, short_margin: 0, short_size: 0, short_entry: 0, short_lev: 0, long_margin: 0, long_size: 0, long_entry: 0, long_lev: 0, lp_amount: 0, lp_entry: 0, lp_range_low: 0, lp_range_high: 0 };
    let currentPhase = null;
    let strategyActive = false;
    const minCandles = 50;

    for (let i = minCandles; i < candles.length; i++) {
        const day = candles[i];
        const price = day.close;
        const date = new Date(day.ts).toISOString().split('T')[0];
        const histCandles = candles.slice(0, i + 1);
        const phase = detectPhaseFromCandles(histCandles.slice(-60), price);

        // Phase change detected
        if (phase !== currentPhase) {
            const prevPhase = currentPhase;
            currentPhase = phase;

            if (strategyActive) {
                // Close all positions
                const closeResult = closeAllPositions(positions, price, date, log);
                cash += closeResult;
                positions = { aave_supply: 0, aave_borrow: 0, short_margin: 0, short_size: 0, short_entry: 0, short_lev: 0, long_margin: 0, long_size: 0, long_entry: 0, long_lev: 0, lp_amount: 0, lp_entry: 0, lp_range_low: 0, lp_range_high: 0 };
                log.push({ date, type: 'phase_change', message: `Cambio: ${prevPhase} → ${phase}. Cerradas todas las posiciones. Cash: $${cash.toFixed(0)}` });
            }

            // Open new strategy based on new phase
            strategyActive = true;
            const allocated = openStrategy(phase, cash, price, asset, positions, date, log);
            cash -= allocated;
        }

        // Daily P&L calculation
        if (strategyActive) {
            const unrealized = calcUnrealizedPnL(positions, price);
            const totalValue = cash + unrealized;
            dailyPnL.push({ date, price, phase: currentPhase, cash, unrealized, totalValue, pnlPct: ((totalValue - amount) / amount * 100) });

            // Check LP out of range
            if (positions.lp_amount > 0 && (price < positions.lp_range_low || price > positions.lp_range_high)) {
                const lpLoss = positions.lp_amount * 0.02;
                log.push({ date, type: 'lp_rebalance', message: `LP fuera de rango ($${positions.lp_range_low.toFixed(0)}-$${positions.lp_range_high.toFixed(0)}). Rebalanceado. Coste: $${lpLoss.toFixed(0)}` });
                cash -= lpLoss;
                positions.lp_range_low = price * 0.92;
                positions.lp_range_high = price * 1.08;
                positions.lp_entry = price;
            }

            // Daily LP fees
            if (positions.lp_amount > 0) {
                const dailyFee = positions.lp_amount * (LP_APY[`${asset}-USDC`] || 20) / 100 / 365;
                cash += dailyFee;
            }

            // Daily Aave yield
            if (positions.aave_supply > 0) {
                cash += positions.aave_supply * 0.035 / 365;
            }
            if (positions.aave_borrow > 0) {
                cash -= positions.aave_borrow * (AAVE_BORROW_APY[asset] || 3) / 100 / 365;
            }

            // Check liquidation
            if (positions.short_margin > 0) {
                const shortPnl = (positions.short_entry - price) / positions.short_entry * positions.short_size;
                if (positions.short_margin + shortPnl <= positions.short_margin * 0.1) {
                    log.push({ date, type: 'liquidation', message: `SHORT liquidado a $${price.toFixed(0)}. Pérdida: $${positions.short_margin.toFixed(0)}` });
                    cash -= positions.short_margin;
                    positions.short_margin = 0; positions.short_size = 0;
                }
            }
            if (positions.long_margin > 0) {
                const longPnl = (price - positions.long_entry) / positions.long_entry * positions.long_size;
                if (positions.long_margin + longPnl <= positions.long_margin * 0.1) {
                    log.push({ date, type: 'liquidation', message: `LONG liquidado a $${price.toFixed(0)}. Pérdida: $${positions.long_margin.toFixed(0)}` });
                    cash -= positions.long_margin;
                    positions.long_margin = 0; positions.long_size = 0;
                }
            }
        }
    }

    // Close everything at end
    if (strategyActive) {
        const lastPrice = candles[candles.length - 1].close;
        const lastDate = new Date(candles[candles.length - 1].ts).toISOString().split('T')[0];
        const closeResult = closeAllPositions(positions, lastPrice, lastDate, log);
        cash += closeResult;
        log.push({ date: lastDate, type: 'end', message: `Simulación finalizada. Cash final: $${cash.toFixed(0)}` });
    }

    const finalValue = cash;
    const totalReturn = ((finalValue - amount) / amount * 100);
    const buyHoldReturn = candles.length > minCandles
        ? ((candles[candles.length - 1].close - candles[minCandles].close) / candles[minCandles].close * 100)
        : 0;

    return {
        initialAmount: amount,
        finalValue: parseFloat(finalValue.toFixed(2)),
        totalReturn: parseFloat(totalReturn.toFixed(2)),
        buyHoldReturn: parseFloat(buyHoldReturn.toFixed(2)),
        alpha: parseFloat((totalReturn - buyHoldReturn).toFixed(2)),
        totalDays: candles.length - minCandles,
        phaseChanges: log.filter(l => l.type === 'phase_change').length,
        liquidations: log.filter(l => l.type === 'liquidation').length,
        log,
        dailyPnL,
        startDate: new Date(candles[minCandles]?.ts).toISOString().split('T')[0],
        endDate: new Date(candles[candles.length - 1]?.ts).toISOString().split('T')[0],
    };
}

function openStrategy(phase, cash, price, asset, pos, date, log) {
    let allocated = 0;

    if (phase === 'bear') {
        const stableAmt = Math.floor(cash * 0.70);
        pos.aave_supply = stableAmt;
        allocated += stableAmt;

        const shortMargin = Math.floor(cash * 0.20);
        pos.short_margin = shortMargin;
        pos.short_lev = 5;
        pos.short_size = shortMargin * 5;
        pos.short_entry = price;
        allocated += shortMargin;

        log.push({ date, type: 'open', message: `E4 BAJISTA: Supply $${stableAmt} USDC + SHORT ${asset} x5 $${shortMargin} margen (entrada $${price.toFixed(0)})` });

    } else if (phase === 'bull') {
        pos.aave_supply = cash;
        const borrow = Math.floor(cash * 0.65);
        pos.aave_borrow = borrow;

        const lpAmt = Math.floor(borrow * 0.90);
        pos.lp_amount = lpAmt;
        pos.lp_entry = price;
        pos.lp_range_low = price * 0.95;
        pos.lp_range_high = price * 1.25;

        const longMargin = Math.floor(borrow * 0.10);
        pos.long_margin = longMargin;
        pos.long_lev = 10;
        pos.long_size = longMargin * 10;
        pos.long_entry = price;
        allocated = cash;

        log.push({ date, type: 'open', message: `E2 ALCISTA: Colateral $${cash.toFixed(0)}, Borrow $${borrow}, LP $${lpAmt} rango $${pos.lp_range_low.toFixed(0)}-$${pos.lp_range_high.toFixed(0)}, LONG x10 $${longMargin} (entrada $${price.toFixed(0)})` });

    } else if (phase === 'accumulation') {
        pos.aave_supply = cash;
        const borrow = Math.floor(cash * 0.45);
        pos.aave_borrow = borrow;

        const lpAmt = Math.floor(borrow * 0.80);
        pos.lp_amount = lpAmt;
        pos.lp_entry = price;
        pos.lp_range_low = price * 0.92;
        pos.lp_range_high = price * 1.08;

        const hedgeAmt = Math.floor(borrow * 0.15);
        pos.short_margin = hedgeAmt;
        pos.short_lev = 3;
        pos.short_size = hedgeAmt * 3;
        pos.short_entry = price;
        allocated = cash;

        log.push({ date, type: 'open', message: `E1 ACUMULACIÓN: Colateral $${cash.toFixed(0)}, Borrow $${borrow}, LP estrecho $${lpAmt}, SHORT hedge x3 $${hedgeAmt} (entrada $${price.toFixed(0)})` });

    } else if (phase === 'distribution') {
        pos.aave_supply = cash;
        const borrow = Math.floor(cash * 0.35);
        pos.aave_borrow = borrow;

        const shortMargin = Math.floor(cash * 0.15);
        pos.short_margin = shortMargin;
        pos.short_lev = 5;
        pos.short_size = shortMargin * 5;
        pos.short_entry = price;
        allocated = cash;

        log.push({ date, type: 'open', message: `E3 DISTRIBUCIÓN: Colateral $${cash.toFixed(0)}, Borrow+Venta $${borrow} (short sintético), SHORT x5 $${shortMargin} (entrada $${price.toFixed(0)})` });
    }

    return allocated;
}

function closeAllPositions(pos, price, date, log) {
    let recovered = 0;

    if (pos.aave_supply > 0) { recovered += pos.aave_supply; }

    if (pos.short_margin > 0 && pos.short_entry > 0) {
        const pnl = (pos.short_entry - price) / pos.short_entry * pos.short_size;
        const total = pos.short_margin + pnl;
        const result = Math.max(0, total);
        log.push({ date, type: 'close', message: `Cerrar SHORT: entrada $${pos.short_entry.toFixed(0)}, salida $${price.toFixed(0)}, P&L: $${pnl.toFixed(0)} (${(pnl/pos.short_margin*100).toFixed(1)}%)` });
        recovered += result;
    }

    if (pos.long_margin > 0 && pos.long_entry > 0) {
        const pnl = (price - pos.long_entry) / pos.long_entry * pos.long_size;
        const total = pos.long_margin + pnl;
        const result = Math.max(0, total);
        log.push({ date, type: 'close', message: `Cerrar LONG: entrada $${pos.long_entry.toFixed(0)}, salida $${price.toFixed(0)}, P&L: $${pnl.toFixed(0)} (${(pnl/pos.long_margin*100).toFixed(1)}%)` });
        recovered += result;
    }

    if (pos.lp_amount > 0) {
        const priceChange = Math.abs(price - pos.lp_entry) / pos.lp_entry;
        const ilLoss = pos.lp_amount * priceChange * 0.5;
        const lpValue = pos.lp_amount - ilLoss;
        log.push({ date, type: 'close', message: `Cerrar LP: IL estimado $${ilLoss.toFixed(0)}, valor recuperado $${lpValue.toFixed(0)}` });
        recovered += Math.max(0, lpValue);
    }

    if (pos.aave_borrow > 0) { recovered -= pos.aave_borrow; }

    return recovered;
}

function calcUnrealizedPnL(pos, price) {
    let total = pos.aave_supply - pos.aave_borrow;
    if (pos.short_margin > 0 && pos.short_entry > 0) {
        total += pos.short_margin + (pos.short_entry - price) / pos.short_entry * pos.short_size;
    }
    if (pos.long_margin > 0 && pos.long_entry > 0) {
        total += pos.long_margin + (price - pos.long_entry) / pos.long_entry * pos.long_size;
    }
    if (pos.lp_amount > 0) {
        const il = pos.lp_amount * Math.abs(price - pos.lp_entry) / pos.lp_entry * 0.5;
        total += pos.lp_amount - il;
    }
    return total;
}

async function simulate(asset, amount, startDate) {
    const db = getDb();
    const pair = asset + 'USDT';
    const startTs = new Date(startDate).getTime();

    const candles = db.prepare(
        'SELECT * FROM candles WHERE pair = ? AND interval = ? AND open_time >= ? ORDER BY open_time ASC'
    ).all(pair, '1d', startTs);

    const preCandles = db.prepare(
        'SELECT * FROM candles WHERE pair = ? AND interval = ? AND open_time < ? ORDER BY open_time DESC LIMIT 60'
    ).all(pair, '1d', startTs).reverse();

    db.close();

    const allCandles = [...preCandles, ...candles].map(c => ({
        ts: c.open_time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    }));

    if (allCandles.length < 55) {
        throw new Error(`No hay suficientes datos para ${asset}. Velas encontradas: ${allCandles.length}. Necesarias: 55+. Sincroniza primero desde el admin.`);
    }

    return runBacktest(allCandles, amount, asset);
}

module.exports = { simulate };
