const { getDb } = require('../../db/init');
const { sma, smaSlope, detectTrainTracks } = require('./ranges');

const AAVE_BORROW_APY = { ETH: 3.2, BTC: 1.5 };
const AAVE_SUPPLY_APY = 3.5;
const LP_FEE_DAILY = 25 / 100 / 365;

const COOLDOWN_DAYS = 5;
const MIN_HOLD_DAYS = 7;
const LONG_LEV = 3;

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

function emptyPos() {
    return {
        aave_supply: 0,
        // USDC borrow (for bull LP leverage)
        aave_borrow_usdc: 0,
        // Volatile borrow (for bear short via Aave)
        aave_borrow_vol_usd: 0,   // USD value at borrow time
        aave_borrow_vol_entry: 0,  // price when volatile was borrowed
        // Perp positions
        long_margin: 0, long_size: 0, long_entry: 0,
        short_margin: 0, short_size: 0, short_entry: 0,
        // LP
        lp_amount: 0, lp_entry: 0, lp_range_low: 0, lp_range_high: 0,
        lp_mode: null, // 'bull_ride' | 'neutral'
        lp_remounts: 0,
    };
}

function isMajorChange(from, to) {
    if (!from) return true;
    if (from === 'bull' && to === 'bear') return true;
    if (from === 'bear' && to === 'bull') return true;
    return false;
}

// ═══════════════════════════════════════════════════════════════
// Close helpers
// ═══════════════════════════════════════════════════════════════

function closeAll(pos, price, date, log) {
    let recovered = 0;
    if (pos.aave_supply > 0) recovered += pos.aave_supply;

    // Close volatile borrow (Aave short)
    if (pos.aave_borrow_vol_usd > 0) {
        const repay_cost = pos.aave_borrow_vol_usd * (price / pos.aave_borrow_vol_entry);
        const profit = pos.aave_borrow_vol_usd - repay_cost;
        log.push({ date, type: 'close', message: `Cerrar borrow ${price < pos.aave_borrow_vol_entry ? 'volátil' : 'volátil'}: prestado $${pos.aave_borrow_vol_usd.toFixed(0)} a $${pos.aave_borrow_vol_entry.toFixed(0)}, repagar a $${price.toFixed(0)}, P&L: $${profit.toFixed(0)}` });
        recovered += pos.aave_borrow_vol_usd + profit;
    }

    // Close LONG hedge
    if (pos.long_margin > 0) {
        const pnl = (price - pos.long_entry) / pos.long_entry * pos.long_size;
        const result = Math.max(0, pos.long_margin + pnl);
        log.push({ date, type: 'close', message: `Cerrar LONG hedge: entrada $${pos.long_entry.toFixed(0)}, salida $${price.toFixed(0)}, P&L: $${pnl.toFixed(0)}` });
        recovered += result;
    }

    // Close SHORT perp
    if (pos.short_margin > 0) {
        const pnl = (pos.short_entry - price) / pos.short_entry * pos.short_size;
        const result = Math.max(0, pos.short_margin + pnl);
        log.push({ date, type: 'close', message: `Cerrar SHORT: entrada $${pos.short_entry.toFixed(0)}, salida $${price.toFixed(0)}, P&L: $${pnl.toFixed(0)}` });
        recovered += result;
    }

    // Close LP
    if (pos.lp_amount > 0) {
        const lpVal = getLpValue(pos, price);
        log.push({ date, type: 'close', message: `Cerrar LP (${pos.lp_mode}): valor $${lpVal.toFixed(0)}, remontadas: ${pos.lp_remounts}` });
        recovered += lpVal;
    }

    // Repay USDC borrow
    if (pos.aave_borrow_usdc > 0) recovered -= pos.aave_borrow_usdc;

    return recovered;
}

function closePerps(pos, price, date, log) {
    let recovered = 0;
    if (pos.short_margin > 0) {
        const pnl = (pos.short_entry - price) / pos.short_entry * pos.short_size;
        recovered += Math.max(0, pos.short_margin + pnl);
        log.push({ date, type: 'adjust_close', message: `Cerrar SHORT: P&L $${pnl.toFixed(0)}` });
        pos.short_margin = 0; pos.short_size = 0; pos.short_entry = 0;
    }
    if (pos.long_margin > 0) {
        const pnl = (price - pos.long_entry) / pos.long_entry * pos.long_size;
        recovered += Math.max(0, pos.long_margin + pnl);
        log.push({ date, type: 'adjust_close', message: `Cerrar LONG: P&L $${pnl.toFixed(0)}` });
        pos.long_margin = 0; pos.long_size = 0; pos.long_entry = 0;
    }
    return recovered;
}

function closeBorrowVol(pos, price, date, log) {
    let recovered = 0;
    if (pos.aave_borrow_vol_usd > 0) {
        const repay_cost = pos.aave_borrow_vol_usd * (price / pos.aave_borrow_vol_entry);
        const profit = pos.aave_borrow_vol_usd - repay_cost;
        log.push({ date, type: 'adjust_close', message: `Cerrar borrow volátil: P&L $${profit.toFixed(0)} (${(profit / pos.aave_borrow_vol_usd * 100).toFixed(1)}%)` });
        recovered += pos.aave_borrow_vol_usd + profit;
        pos.aave_borrow_vol_usd = 0; pos.aave_borrow_vol_entry = 0;
    }
    return recovered;
}

function closeLp(pos, price, date, log) {
    let recovered = 0;
    if (pos.lp_amount > 0) {
        const lpVal = getLpValue(pos, price);
        if (log.length >= 0) log.push({ date, type: 'close', message: `Cerrar LP: valor $${lpVal.toFixed(0)}` });
        recovered += lpVal;
        pos.lp_amount = 0; pos.lp_mode = null;
    }
    if (pos.aave_borrow_usdc > 0) {
        recovered -= pos.aave_borrow_usdc;
        pos.aave_borrow_usdc = 0;
    }
    return recovered;
}

function getLpValue(pos, price) {
    if (pos.lp_amount <= 0) return 0;
    const { lp_amount, lp_range_low, lp_range_high, lp_entry } = pos;

    if (price >= lp_range_high) return lp_amount; // 100% USDC
    if (price <= lp_range_low) return lp_amount * (price / lp_entry); // 100% volatile
    const il = lp_amount * Math.abs(price - lp_entry) / lp_entry * 0.3;
    return Math.max(0, lp_amount - il);
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY PER PHASE
// ═══════════════════════════════════════════════════════════════
//
// E4 BAJISTA:
//   - Supply USDC en Aave (collateral)
//   - Borrow volátil (ETH/BTC) → vender por USDC = short 1x vía Aave
//     → si precio cae, deuda se reduce en USD → profit
//   - LONG pequeño como hedge contra cambio de tendencia
//   - SIN LP
//
// E2 ALCISTA:
//   - LP apalancado via Revert (supply USDC → borrow USDC → LP)
//   - Rango -15%/+30%
//   - Sale por arriba → take profit → remontar más arriba
//   - Sale por abajo → desmontar LP (auto-exit swap a USDC via Revert)
//
// ═══════════════════════════════════════════════════════════════

function openStrategy(phase, cash, price, asset, pos, date, log) {
    let allocated = 0;

    if (phase === 'bear') {
        // E4: Supply USDC + Borrow volátil (short via Aave) + LONG hedge
        const supplyAmt = Math.floor(cash * 0.90);
        pos.aave_supply = supplyAmt;

        // Borrow volatile at 80% LTV → sell for USDC → short 1x
        const borrowVolUsd = Math.floor(supplyAmt * 0.60);
        pos.aave_borrow_vol_usd = borrowVolUsd;
        pos.aave_borrow_vol_entry = price;

        // LONG hedge: protege contra cambio de tendencia
        const longMargin = Math.floor(cash * 0.07);
        pos.long_margin = longMargin;
        pos.long_size = longMargin * LONG_LEV;
        pos.long_entry = price;

        allocated = supplyAmt + longMargin;

        log.push({ date, type: 'open', message: `E4 BAJISTA: Supply $${supplyAmt} → Borrow volátil $${borrowVolUsd} (short 1x a $${price.toFixed(0)}) + LONG hedge x${LONG_LEV} $${longMargin}. Sin LP.` });

    } else if (phase === 'bull') {
        // E2: LP apalancado via Revert
        pos.aave_supply = cash;
        const borrow = Math.floor(cash * 0.55);
        pos.aave_borrow_usdc = borrow;

        pos.lp_amount = borrow; pos.lp_entry = price;
        pos.lp_range_low = price * 0.85;
        pos.lp_range_high = price * 1.30;
        pos.lp_mode = 'bull_ride';
        pos.lp_remounts = 0;
        allocated = cash;

        log.push({ date, type: 'open', message: `E2 ALCISTA: Colateral $${cash.toFixed(0)}, Borrow USDC $${borrow}, LP $${borrow} rango $${pos.lp_range_low.toFixed(0)}-$${pos.lp_range_high.toFixed(0)}. Revert. Take profit → remontar.` });

    } else if (phase === 'accumulation') {
        // E1: LP neutral ±12% + short hedge
        pos.aave_supply = cash;
        const borrow = Math.floor(cash * 0.40);
        pos.aave_borrow_usdc = borrow;

        const hedgeAmt = Math.floor(borrow * 0.10);
        const lpAmt = borrow - hedgeAmt;
        pos.lp_amount = lpAmt; pos.lp_entry = price;
        pos.lp_range_low = price * 0.88;
        pos.lp_range_high = price * 1.12;
        pos.lp_mode = 'neutral';

        pos.short_margin = hedgeAmt; pos.short_size = hedgeAmt * LONG_LEV; pos.short_entry = price;
        allocated = cash;

        log.push({ date, type: 'open', message: `E1 ACUMULACIÓN: Colateral $${cash.toFixed(0)}, LP $${lpAmt} ±12%, SHORT hedge x3 $${hedgeAmt}` });

    } else if (phase === 'distribution') {
        // E3: LP conservador ±10% + short hedge mayor
        pos.aave_supply = cash;
        const borrow = Math.floor(cash * 0.30);
        pos.aave_borrow_usdc = borrow;

        const hedgeAmt = Math.floor(borrow * 0.15);
        const lpAmt = borrow - hedgeAmt;
        pos.lp_amount = lpAmt; pos.lp_entry = price;
        pos.lp_range_low = price * 0.90;
        pos.lp_range_high = price * 1.10;
        pos.lp_mode = 'neutral';

        pos.short_margin = hedgeAmt; pos.short_size = hedgeAmt * LONG_LEV; pos.short_entry = price;
        allocated = cash;

        log.push({ date, type: 'open', message: `E3 DISTRIBUCIÓN: Colateral $${cash.toFixed(0)}, LP $${lpAmt} ±10%, SHORT hedge x3 $${hedgeAmt}` });
    }
    return allocated;
}

// ═══════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════

function runBacktest(candles, amount, asset) {
    const log = [];
    const dailyPnL = [];
    let cash = amount;
    let pos = emptyPos();
    let confirmedPhase = null;
    let pendingPhase = null;
    let pendingCount = 0;
    let strategyActive = false;
    let daysSinceOpen = 0;
    const minC = 50;

    for (let i = minC; i < candles.length; i++) {
        const price = candles[i].close;
        const date = new Date(candles[i].ts).toISOString().split('T')[0];
        const rawPhase = detectPhaseFromCandles(candles.slice(Math.max(0, i - 59), i + 1), price);

        if (strategyActive) daysSinceOpen++;

        // ── LP auto-exit (only bull_ride and neutral) ──
        if (strategyActive && pos.lp_amount > 0) {
            if (pos.lp_mode === 'bull_ride' && price > pos.lp_range_high) {
                // ★ TAKE PROFIT: 100% USDC → remontar más arriba
                pos.lp_remounts++;
                log.push({ date, type: 'lp_exit_top', message: `LP TAKE PROFIT #${pos.lp_remounts}: $${price.toFixed(0)} > $${pos.lp_range_high.toFixed(0)}. LP = $${pos.lp_amount.toFixed(0)} USDC` });
                pos.lp_entry = price;
                pos.lp_range_low = price * 0.85;
                pos.lp_range_high = price * 1.30;
                const cost = pos.lp_amount * 0.005;
                cash -= cost;
                log.push({ date, type: 'lp_remount', message: `Remontado $${pos.lp_range_low.toFixed(0)}-$${pos.lp_range_high.toFixed(0)}. Coste: $${cost.toFixed(0)}` });

            } else if (pos.lp_mode === 'bull_ride' && price < pos.lp_range_low) {
                // ★ EXIT BOTTOM: auto-exit swap a USDC via Revert
                const lpVal = getLpValue(pos, price);
                log.push({ date, type: 'lp_exit_bottom', message: `LP AUTO-EXIT → USDC via Revert: $${price.toFixed(0)} < $${pos.lp_range_low.toFixed(0)}. Swap volátil→USDC. Valor: $${lpVal.toFixed(0)}` });
                cash += closeLp(pos, price, date, []);

            } else if (pos.lp_mode === 'neutral' && (price < pos.lp_range_low || price > pos.lp_range_high)) {
                const lpVal = getLpValue(pos, price);
                const cost = lpVal * 0.01;
                cash -= cost;
                pos.lp_entry = price;
                const w = confirmedPhase === 'distribution' ? 0.10 : 0.12;
                pos.lp_range_low = price * (1 - w);
                pos.lp_range_high = price * (1 + w);
                log.push({ date, type: 'lp_rebalance', message: `LP rebalanceado a $${price.toFixed(0)}. Coste: $${cost.toFixed(0)}` });
            }

            // Daily LP fees (in range only)
            if (pos.lp_amount > 0 && price >= pos.lp_range_low && price <= pos.lp_range_high) {
                cash += pos.lp_amount * LP_FEE_DAILY;
            }
        }

        // Daily Aave yields/costs
        if (pos.aave_supply > 0) cash += pos.aave_supply * AAVE_SUPPLY_APY / 100 / 365;
        if (pos.aave_borrow_usdc > 0) cash -= pos.aave_borrow_usdc * 0.03 / 365; // ~3% USDC borrow
        if (pos.aave_borrow_vol_usd > 0) cash -= pos.aave_borrow_vol_usd * (AAVE_BORROW_APY[asset] || 3) / 100 / 365;

        // Liquidation checks
        if (pos.short_margin > 0) {
            const pnl = (pos.short_entry - price) / pos.short_entry * pos.short_size;
            if (pos.short_margin + pnl <= pos.short_margin * 0.1) {
                log.push({ date, type: 'liquidation', message: `SHORT liquidado $${price.toFixed(0)}. Pérdida: $${pos.short_margin.toFixed(0)}` });
                pos.short_margin = 0; pos.short_size = 0; pos.short_entry = 0;
            }
        }
        if (pos.long_margin > 0) {
            const pnl = (price - pos.long_entry) / pos.long_entry * pos.long_size;
            if (pos.long_margin + pnl <= pos.long_margin * 0.1) {
                log.push({ date, type: 'liquidation', message: `LONG hedge liquidado $${price.toFixed(0)}. Pérdida: $${pos.long_margin.toFixed(0)}` });
                pos.long_margin = 0; pos.long_size = 0; pos.long_entry = 0;
            }
        }

        // Aave volatile borrow liquidation (health factor)
        if (pos.aave_borrow_vol_usd > 0 && pos.aave_supply > 0) {
            const debt_current = pos.aave_borrow_vol_usd * (price / pos.aave_borrow_vol_entry);
            const hf = (pos.aave_supply * 0.80) / debt_current;
            if (hf < 1.05) {
                log.push({ date, type: 'liquidation', message: `Aave HF=${hf.toFixed(2)} — cerrando borrow volátil para evitar liquidación` });
                cash += closeBorrowVol(pos, price, date, []);
            }
        }

        // ── Phase change logic ──
        if (rawPhase !== confirmedPhase) {
            if (rawPhase === pendingPhase) pendingCount++;
            else { pendingPhase = rawPhase; pendingCount = 1; }
        } else { pendingPhase = null; pendingCount = 0; }

        if (pendingPhase && pendingCount >= COOLDOWN_DAYS) {
            const newPhase = pendingPhase;
            const prevPhase = confirmedPhase;
            pendingPhase = null; pendingCount = 0;

            if (strategyActive && daysSinceOpen < MIN_HOLD_DAYS) {
                log.push({ date, type: 'cooldown', message: `${newPhase} confirmada pero hold ${daysSinceOpen}d < ${MIN_HOLD_DAYS}d.` });
            } else {
                const major = isMajorChange(prevPhase, newPhase);

                if (strategyActive && major) {
                    cash += closeAll(pos, price, date, log);
                    pos = emptyPos();
                    log.push({ date, type: 'phase_change', message: `CAMBIO MAYOR: ${prevPhase} → ${newPhase}. Cash: $${cash.toFixed(0)}` });
                    confirmedPhase = newPhase; daysSinceOpen = 0;
                    cash -= openStrategy(newPhase, cash, price, asset, pos, date, log);

                } else if (strategyActive && !major) {
                    cash += closePerps(pos, price, date, log);
                    const prevConfirmed = confirmedPhase;
                    confirmedPhase = newPhase;

                    if (newPhase === 'bear' && pos.lp_amount > 0 && pos.lp_mode === 'bull_ride') {
                        // Bull LP → desmontar con auto-exit USDC + abrir borrow volátil
                        const lpVal = getLpValue(pos, price);
                        log.push({ date, type: 'phase_adjust', message: `${prevConfirmed} → E4: Auto-exit LP → USDC via Revert ($${lpVal.toFixed(0)})` });
                        cash += closeLp(pos, price, date, []);
                        // Abrir borrow volátil
                        const borrowVol = Math.floor(pos.aave_supply * 0.50);
                        if (borrowVol > 50) {
                            pos.aave_borrow_vol_usd = borrowVol;
                            pos.aave_borrow_vol_entry = price;
                            const longM = Math.floor(cash * 0.05);
                            if (longM > 20) {
                                pos.long_margin = longM; pos.long_size = longM * LONG_LEV; pos.long_entry = price;
                                cash -= longM;
                            }
                            log.push({ date, type: 'phase_adjust', message: `→ Borrow volátil $${borrowVol} (short 1x) + LONG hedge $${pos.long_margin}` });
                        }
                    } else if (newPhase === 'bear' || newPhase === 'distribution') {
                        const hm = Math.floor(cash * (newPhase === 'bear' ? 0.10 : 0.05));
                        if (hm > 30) {
                            pos.short_margin = hm; pos.short_size = hm * LONG_LEV; pos.short_entry = price;
                            cash -= hm;
                            log.push({ date, type: 'phase_adjust', message: `${prevConfirmed} → ${newPhase}: SHORT x3 $${hm}` });
                        } else {
                            log.push({ date, type: 'phase_adjust', message: `${prevConfirmed} → ${newPhase}: mantenido.` });
                        }
                    } else if (newPhase === 'accumulation') {
                        const hm = Math.floor(cash * 0.03);
                        if (hm > 30) {
                            pos.short_margin = hm; pos.short_size = hm * LONG_LEV; pos.short_entry = price;
                            cash -= hm;
                            log.push({ date, type: 'phase_adjust', message: `${prevConfirmed} → E1: SHORT delta-neutral x3 $${hm}` });
                        } else {
                            log.push({ date, type: 'phase_adjust', message: `${prevConfirmed} → E1: mantenido.` });
                        }
                    } else if (newPhase === 'bull') {
                        // Cerrar borrow volátil si lo hay
                        if (pos.aave_borrow_vol_usd > 0) {
                            cash += closeBorrowVol(pos, price, date, log);
                        }
                        // Montar LP bull si no hay
                        if (pos.lp_amount <= 0 && pos.aave_supply > 100) {
                            const borrow = Math.floor(pos.aave_supply * 0.55);
                            if (borrow > 100) {
                                pos.aave_borrow_usdc = borrow;
                                pos.lp_amount = borrow; pos.lp_entry = price;
                                pos.lp_range_low = price * 0.85;
                                pos.lp_range_high = price * 1.30;
                                pos.lp_mode = 'bull_ride';
                                pos.lp_remounts = 0;
                                log.push({ date, type: 'phase_adjust', message: `${prevConfirmed} → E2: Montando LP bull $${borrow} rango $${pos.lp_range_low.toFixed(0)}-$${pos.lp_range_high.toFixed(0)}` });
                            }
                        } else {
                            log.push({ date, type: 'phase_adjust', message: `${prevConfirmed} → E2: LP mantenido.` });
                        }
                    }
                } else {
                    confirmedPhase = newPhase; strategyActive = true; daysSinceOpen = 0;
                    cash -= openStrategy(newPhase, cash, price, asset, pos, date, log);
                }
            }
        }

        // Daily P&L
        if (strategyActive) {
            let totalVal = cash;
            if (pos.short_margin > 0) totalVal += pos.short_margin + (pos.short_entry - price) / pos.short_entry * pos.short_size;
            if (pos.long_margin > 0) totalVal += pos.long_margin + (price - pos.long_entry) / pos.long_entry * pos.long_size;
            if (pos.aave_borrow_vol_usd > 0) {
                const bvProfit = pos.aave_borrow_vol_usd * (1 - price / pos.aave_borrow_vol_entry);
                totalVal += pos.aave_borrow_vol_usd + bvProfit;
            }
            if (pos.lp_amount > 0) totalVal += getLpValue(pos, price);
            dailyPnL.push({ date, price, phase: confirmedPhase, cash, totalValue: totalVal, pnlPct: ((totalVal - amount) / amount * 100) });
        }
    }

    if (strategyActive) {
        const lp = candles[candles.length - 1].close;
        const ld = new Date(candles[candles.length - 1].ts).toISOString().split('T')[0];
        cash += closeAll(pos, lp, ld, log);
        log.push({ date: ld, type: 'end', message: `Fin simulación. Cash: $${cash.toFixed(0)}` });
    }

    const bh = candles.length > minC ? ((candles[candles.length - 1].close - candles[minC].close) / candles[minC].close * 100) : 0;
    const ret = ((cash - amount) / amount * 100);

    return {
        initialAmount: amount, finalValue: +cash.toFixed(2),
        totalReturn: +ret.toFixed(2), buyHoldReturn: +bh.toFixed(2),
        alpha: +(ret - bh).toFixed(2), totalDays: candles.length - minC,
        phaseChanges: log.filter(l => l.type === 'phase_change').length,
        liquidations: log.filter(l => l.type === 'liquidation').length,
        lpExitTop: log.filter(l => l.type === 'lp_exit_top').length,
        lpExitBottom: log.filter(l => l.type === 'lp_exit_bottom').length,
        lpAutoUsdc: log.filter(l => l.type === 'lp_auto_usdc').length,
        log, dailyPnL,
        startDate: new Date(candles[minC]?.ts).toISOString().split('T')[0],
        endDate: new Date(candles[candles.length - 1]?.ts).toISOString().split('T')[0],
    };
}

async function simulate(asset, amount, startDate) {
    const db = getDb();
    const pair = asset + 'USDT';
    const startTs = new Date(startDate).getTime();
    const candles = db.prepare('SELECT * FROM candles WHERE pair = ? AND interval = ? AND open_time >= ? ORDER BY open_time ASC').all(pair, '1d', startTs);
    const pre = db.prepare('SELECT * FROM candles WHERE pair = ? AND interval = ? AND open_time < ? ORDER BY open_time DESC LIMIT 60').all(pair, '1d', startTs).reverse();
    db.close();
    const all = [...pre, ...candles].map(c => ({ ts: c.open_time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    if (all.length < 55) throw new Error(`Datos insuficientes para ${asset}. Sincroniza desde /admin.`);
    return runBacktest(all, amount, asset);
}

module.exports = { simulate };
