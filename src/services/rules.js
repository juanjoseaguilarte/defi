const { fetchKlines, fetchAllPrices } = require('./binance');
const { detectPhase } = require('./phases');
const { sma, smaSlope } = require('./ranges');
const { getDb } = require('../../db/init');

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

const SHORT_LEV = 7;
const LONG_LEV = 3;
const LP_LEVERAGE = 2.5;
const LP_RANGE_DOWN = 0.20;
const LP_RANGE_UP = 0.25;
const COOLDOWN_DAYS = 5;

const ALERT_PRIORITY = { critical: 0, action: 1, warning: 2, info: 3 };

// ═══════════════════════════════════════════════════════════════
// ENTRY RULES — When to open positions
// ═══════════════════════════════════════════════════════════════

const ENTRY_RULES = {
    bull: {
        name: 'E2 ALCISTA',
        conditions: [
            'SMA20 verde con pendiente positiva >0.5%',
            'Precio por encima de SMA20',
            'SMA20 > SMA40 (vías del tren alcistas)',
            'Confirmado durante 5 días consecutivos',
        ],
        actions: [
            { id: 'supply_aave', desc: 'Depositar 100% capital en Aave como colateral USDC' },
            { id: 'borrow_usdc', desc: 'Borrow USDC = 30% capital x (2.5-1) = 45% del capital' },
            { id: 'open_lp', desc: 'LP con base (30%) + borrow (45%) = 75% total en Uniswap/Camelot via Revert' },
            { id: 'set_lp_range', desc: 'Rango LP: -20% / +25% del precio actual' },
        ],
        sizing: { lp_base_pct: 0.30, lp_leverage: 2.5, total_lp_pct: 0.75 },
    },
    bear: {
        name: 'E4 BAJISTA',
        conditions: [
            'SMA20 roja con pendiente negativa <-0.5%',
            'Precio por debajo de SMA20',
            'SMA20 < SMA40 (vías del tren bajistas)',
            'Confirmado durante 5 días consecutivos',
        ],
        actions: [
            { id: 'supply_aave', desc: 'Depositar 65% capital en Aave como colateral USDC' },
            { id: 'borrow_vol', desc: 'Borrow volátil (ETH/BTC) al 55% del colateral → vender por USDC = short 1x' },
            { id: 'open_short', desc: 'SHORT perps x7 con 15% del capital' },
            { id: 'open_long_hedge', desc: 'LONG hedge x3 con 17% del capital (seguro contra giro)' },
        ],
        sizing: { supply_pct: 0.65, borrow_vol_pct: 0.55, short_pct: 0.15, long_hedge_pct: 0.17 },
    },
    accumulation: {
        name: 'E1 ACUMULACIÓN',
        conditions: [
            'SMA20 aplanándose tras tendencia bajista',
            'Precio cortando SMA20 erráticamente',
            'SMA20 por debajo de SMA40',
        ],
        actions: [
            { id: 'supply_aave', desc: 'Depositar 100% capital en Aave USDC (3.5% APY)' },
            { id: 'wait', desc: 'NO abrir LP. Esperar confirmación de E2 para actuar' },
        ],
        sizing: { supply_pct: 1.0 },
    },
    distribution: {
        name: 'E3 DISTRIBUCIÓN',
        conditions: [
            'SMA20 aplanándose tras tendencia alcista',
            'Precio cortando SMA20 erráticamente',
            'SMA20 por encima de SMA40',
        ],
        actions: [
            { id: 'supply_aave', desc: 'Depositar 100% capital en Aave USDC (3.5% APY)' },
            { id: 'wait', desc: 'NO abrir LP. Esperar confirmación de E4 para shortear' },
        ],
        sizing: { supply_pct: 1.0 },
    },
};

// ═══════════════════════════════════════════════════════════════
// EXIT RULES — When to close/adjust positions
// ═══════════════════════════════════════════════════════════════

const EXIT_RULES = {
    bull_lp_top: {
        name: 'LP TAKE PROFIT (sale por arriba)',
        trigger: 'Precio > rango_alto del LP',
        actions: [
            'LP ahora es 100% USDC (todo vendido arriba)',
            'Remontar: mover rango a precio_actual -20% / +25%',
            'Coste estimado: 0.5% del LP (gas + slippage)',
        ],
        unlimited: true,
    },
    bull_lp_bottom: {
        name: 'LP REBALANCEO (sale por abajo)',
        trigger: 'Precio < rango_bajo del LP',
        actions: [
            'Rebalancear LP a nuevo rango: precio_actual -20% / +25%',
            'Abrir SHORT cobertura x7 con margen = 50% valor LP / 7',
            'Si ya hay SHORT activo: solo rebalancear LP',
            'Coste estimado: 1% del LP (gas + IL cristalizada)',
        ],
        unlimited: true,
    },
    bear_hf_danger: {
        name: 'HEALTH FACTOR PELIGRO',
        trigger: 'Aave Health Factor < 1.3',
        actions: [
            'URGENTE: Repagar parte del borrow volátil',
            'O añadir más colateral USDC',
            'Si HF < 1.05: cerrar borrow volátil completo',
        ],
        priority: 'critical',
    },
    bear_short_liq: {
        name: 'SHORT CERCA DE LIQUIDACIÓN',
        trigger: 'Precio sube >12% desde entrada del SHORT (90% del margen perdido)',
        actions: [
            'Cerrar SHORT x7 para salvar margen restante',
            'El LONG hedge debería estar compensando',
            'Evaluar si re-entrar short a mejor precio',
        ],
        priority: 'critical',
    },
    bear_long_liq: {
        name: 'LONG HEDGE LIQUIDADO',
        trigger: 'Precio baja >30% desde entrada del LONG',
        actions: [
            'LONG hedge liquidado — esto es esperado en E4',
            'El SHORT x7 y borrow vol están ganando',
            'NO re-abrir LONG hedge a menos que fase cambie',
        ],
        priority: 'warning',
    },
    phase_change_major: {
        name: 'CAMBIO DE FASE MAYOR',
        trigger: 'Bull → Bear o Bear → Bull (confirmado 5 días)',
        actions: [
            'CERRAR TODO: LP, perps, borrow vol',
            'Esperar a que cash esté 100% disponible',
            'Abrir nueva estrategia según fase nueva',
        ],
        priority: 'critical',
    },
    phase_change_minor: {
        name: 'CAMBIO DE FASE MENOR',
        trigger: 'Bull → Distribución/Acumulación o Bear → Distribución/Acumulación',
        actions: [
            'Cerrar perps (SHORT y LONG)',
            'Mantener LP si existe y está en rango',
            'Si hay borrow vol: mantener mientras HF > 1.5',
            'Ir a modo "stables en Aave, esperar"',
        ],
        priority: 'action',
    },
};

// ═══════════════════════════════════════════════════════════════
// LIVE RULE CHECKER
// ═══════════════════════════════════════════════════════════════

async function checkRules(activeStrategy) {
    const alerts = [];
    const prices = await fetchAllPrices();
    const now = new Date().toISOString();

    for (const asset of ['BTC', 'ETH']) {
        const pair = asset + 'USDT';
        const price = prices[pair];
        if (!price) continue;

        const candles = await fetchKlines(pair, '1d', 60);
        const phase = detectPhase(candles, price);
        const closes = candles.map(c => c.close);
        const sma20 = sma(closes, 20);
        const lastSma20 = sma20.filter(v => v !== null).pop();
        const slope = smaSlope(sma20, 5);
        const distPct = ((price - lastSma20) / lastSma20) * 100;

        // Phase detection alert
        alerts.push({
            asset, price, phase: phase.type, phaseName: phase.phase,
            reason: phase.reason, sma20: lastSma20, slope, distPct,
            type: 'info', category: 'phase_status', time: now,
            message: `${asset}: ${phase.phase} | $${price.toFixed(0)} | SMA20: $${lastSma20.toFixed(0)} (${distPct > 0 ? '+' : ''}${distPct.toFixed(1)}%) | Pendiente: ${slope.toFixed(2)}%`,
        });

        if (!activeStrategy) continue;

        const steps = activeStrategy.steps || [];
        const currentPhase = activeStrategy.market_phase;

        // ── LP EXIT CHECKS ──
        const lpStep = steps.find(s => s.lp_range_high && s.done && s.entry_asset === asset);
        if (lpStep) {
            if (price > lpStep.lp_range_high) {
                alerts.push({
                    asset, price, type: 'action', category: 'lp_exit_top', time: now, priority: ALERT_PRIORITY.action,
                    rule: EXIT_RULES.bull_lp_top,
                    message: `TAKE PROFIT: ${asset} $${price.toFixed(0)} superó rango alto $${lpStep.lp_range_high.toFixed(0)}`,
                    actions: [
                        `Remontar LP a nuevo rango: $${(price * (1 - LP_RANGE_DOWN)).toFixed(0)} — $${(price * (1 + LP_RANGE_UP)).toFixed(0)}`,
                        'Ejecutar via Revert Finance (auto-compound)',
                    ],
                });
            }
            if (price < lpStep.lp_range_low) {
                const lpValue = lpStep.margin_amount || lpStep.amount || 0;
                const shortMargin = Math.floor(lpValue * 0.50 / SHORT_LEV);
                alerts.push({
                    asset, price, type: 'action', category: 'lp_exit_bottom', time: now, priority: ALERT_PRIORITY.action,
                    rule: EXIT_RULES.bull_lp_bottom,
                    message: `REBALANCEO: ${asset} $${price.toFixed(0)} cayó bajo rango $${lpStep.lp_range_low.toFixed(0)}`,
                    actions: [
                        `Rebalancear LP a: $${(price * (1 - LP_RANGE_DOWN)).toFixed(0)} — $${(price * (1 + LP_RANGE_UP)).toFixed(0)}`,
                        `Abrir SHORT x${SHORT_LEV} cobertura: margen $${shortMargin} → exposición $${shortMargin * SHORT_LEV}`,
                        `Precio liq SHORT: $${(price * (1 + 0.9 / SHORT_LEV)).toFixed(0)}`,
                    ],
                });
            }
        }

        // ── PERP LIQUIDATION CHECKS ──
        const shortStep = steps.find(s => s.direction === 'SHORT' && s.done && s.entry_asset === asset);
        if (shortStep && shortStep.entry_price) {
            const shortPnlPct = (shortStep.entry_price - price) / shortStep.entry_price;
            const shortLiqPrice = shortStep.entry_price * (1 + 0.9 / (shortStep.leverage || SHORT_LEV));
            if (shortPnlPct < -0.10) {
                alerts.push({
                    asset, price, type: 'critical', category: 'short_danger', time: now, priority: ALERT_PRIORITY.critical,
                    rule: EXIT_RULES.bear_short_liq,
                    message: `SHORT EN PELIGRO: ${asset} subió ${(Math.abs(shortPnlPct) * 100).toFixed(1)}% desde entrada $${shortStep.entry_price.toFixed(0)}`,
                    actions: [
                        `Cerrar SHORT ahora para salvar ${(100 + shortPnlPct * (shortStep.leverage || SHORT_LEV) * 100).toFixed(0)}% del margen`,
                        `Liquidación en: $${shortLiqPrice.toFixed(0)}`,
                    ],
                });
            }
        }

        const longStep = steps.find(s => s.direction === 'LONG' && s.done && s.entry_asset === asset);
        if (longStep && longStep.entry_price) {
            const longPnlPct = (price - longStep.entry_price) / longStep.entry_price;
            const longLiqPrice = longStep.entry_price * (1 - 0.9 / (longStep.leverage || LONG_LEV));
            if (longPnlPct < -0.25) {
                alerts.push({
                    asset, price, type: 'warning', category: 'long_danger', time: now, priority: ALERT_PRIORITY.warning,
                    rule: EXIT_RULES.bear_long_liq,
                    message: `LONG HEDGE cerca de liquidación: ${asset} cayó ${(Math.abs(longPnlPct) * 100).toFixed(1)}% desde entrada $${longStep.entry_price.toFixed(0)}`,
                    actions: [
                        `Liquidación en: $${longLiqPrice.toFixed(0)}`,
                        'Si es E4: aceptar pérdida (SHORT compensa)',
                        'Si NO es E4: cerrar LONG antes de liquidación',
                    ],
                });
            }
        }

        // ── AAVE HEALTH FACTOR ──
        const borrowStep = steps.find(s => s.action?.includes('Borrow') && s.done && s.entry_asset === asset);
        if (borrowStep && borrowStep.entry_price) {
            const collateral = steps.find(s => s.action?.includes('Supply') || s.action?.includes('Depositar'));
            if (collateral) {
                const collateralUsd = collateral.amount || 0;
                const debtNow = (borrowStep.amount || 0) * (price / borrowStep.entry_price);
                const hf = (collateralUsd * 0.80) / debtNow;
                if (hf < 1.3) {
                    alerts.push({
                        asset, price, type: 'critical', category: 'hf_danger', time: now, priority: ALERT_PRIORITY.critical,
                        rule: EXIT_RULES.bear_hf_danger,
                        message: `HEALTH FACTOR ${hf.toFixed(2)}: ${asset} subió a $${price.toFixed(0)}. Deuda: $${debtNow.toFixed(0)}`,
                        actions: hf < 1.05
                            ? ['CERRAR BORROW VOLÁTIL INMEDIATAMENTE', `Recomprar ${asset} al mercado y repagar deuda`]
                            : [`Añadir $${Math.floor(debtNow * 0.2)} colateral USDC`, 'O repagar 20% de la deuda', `HF objetivo: >1.5 (necesitas colateral a $${Math.floor(debtNow * 1.5 / 0.80)})`],
                    });
                }
            }
        }

        // ── PHASE CHANGE DETECTION ──
        if (currentPhase && phase.type !== currentPhase) {
            const isMajor = (currentPhase === 'bull' && phase.type === 'bear') || (currentPhase === 'bear' && phase.type === 'bull');
            if (isMajor) {
                alerts.push({
                    asset, price, type: 'critical', category: 'phase_change_major', time: now, priority: ALERT_PRIORITY.critical,
                    rule: EXIT_RULES.phase_change_major,
                    message: `CAMBIO MAYOR DETECTADO: ${currentPhase} → ${phase.type} en ${asset}`,
                    actions: [
                        'Esperar 5 días de confirmación antes de actuar',
                        `Si se confirma: cerrar TODO y abrir ${ENTRY_RULES[phase.type]?.name || phase.type}`,
                        ...ENTRY_RULES[phase.type]?.actions.map(a => a.desc) || [],
                    ],
                    daysToConfirm: COOLDOWN_DAYS,
                });
            } else {
                alerts.push({
                    asset, price, type: 'warning', category: 'phase_change_minor', time: now, priority: ALERT_PRIORITY.warning,
                    rule: EXIT_RULES.phase_change_minor,
                    message: `Fase cambiando: ${currentPhase} → ${phase.type} en ${asset}`,
                    actions: [
                        'Cerrar perps (SHORT y LONG)',
                        'Mantener LP si en rango',
                        'Ir a modo "stables en Aave, esperar"',
                    ],
                    daysToConfirm: COOLDOWN_DAYS,
                });
            }
        }
    }

    alerts.sort((a, b) => (ALERT_PRIORITY[a.type] || 3) - (ALERT_PRIORITY[b.type] || 3));
    return { alerts, checked_at: now, rules: { entry: ENTRY_RULES, exit: EXIT_RULES } };
}

// ═══════════════════════════════════════════════════════════════
// GENERATE ACTION PLAN for a new phase
// ═══════════════════════════════════════════════════════════════

function generateActionPlan(phase, amount, price, asset) {
    const rule = ENTRY_RULES[phase];
    if (!rule) return null;

    const plan = {
        phase, name: rule.name, asset, price, amount,
        conditions: rule.conditions,
        steps: [],
        warnings: [],
    };

    if (phase === 'bull') {
        const lpBase = Math.floor(amount * rule.sizing.lp_base_pct);
        const borrow = Math.floor(lpBase * (LP_LEVERAGE - 1));
        const lpTotal = lpBase + borrow;
        const rangeLow = price * (1 - LP_RANGE_DOWN);
        const rangeHigh = price * (1 + LP_RANGE_UP);

        plan.steps = [
            { n: 1, action: 'Depositar USDC en Aave', detail: `$${amount} USDC → Aave V3 Arbitrum`, protocol: 'Aave' },
            { n: 2, action: 'Borrow USDC contra colateral', detail: `Borrow $${borrow} USDC (LTV ~${((borrow / amount) * 100).toFixed(0)}%)`, protocol: 'Aave' },
            { n: 3, action: 'Abrir LP via Revert', detail: `$${lpTotal} total ($${lpBase} base + $${borrow} borrow) en ${asset}/USDC`, protocol: 'Revert' },
            { n: 4, action: 'Configurar rango', detail: `$${rangeLow.toFixed(0)} — $${rangeHigh.toFixed(0)} (-${(LP_RANGE_DOWN * 100).toFixed(0)}% / +${(LP_RANGE_UP * 100).toFixed(0)}%)`, protocol: 'Revert' },
            { n: 5, action: 'Activar auto-compound en Revert', detail: 'Fees se reinvierten automáticamente en el LP', protocol: 'Revert' },
        ];
        plan.exit_rules = [
            `Si precio > $${rangeHigh.toFixed(0)}: TAKE PROFIT → remontar rango más arriba`,
            `Si precio < $${rangeLow.toFixed(0)}: REBALANCEAR + abrir SHORT x${SHORT_LEV} cobertura`,
            'Si fase cambia a bear (5 días): CERRAR TODO',
        ];
        plan.warnings = [
            `Liquidación Aave si LP pierde mucho valor (HF vigilar >1.5)`,
            'Revert cobra 3% de los fees recolectados',
        ];

    } else if (phase === 'bear') {
        const supply = Math.floor(amount * rule.sizing.supply_pct);
        const borrowVol = Math.floor(supply * rule.sizing.borrow_vol_pct);
        const shortMargin = Math.floor(amount * rule.sizing.short_pct);
        const longMargin = Math.floor(amount * rule.sizing.long_hedge_pct);
        const shortLiq = price * (1 + 0.9 / SHORT_LEV);
        const longLiq = price * (1 - 0.9 / LONG_LEV);

        plan.steps = [
            { n: 1, action: 'Depositar USDC en Aave', detail: `$${supply} USDC → Aave V3`, protocol: 'Aave' },
            { n: 2, action: `Borrow ${asset} y vender por USDC`, detail: `Borrow $${borrowVol} en ${asset} a $${price.toFixed(0)} → vender → short 1x via lending`, protocol: 'Aave' },
            { n: 3, action: `SHORT ${asset} x${SHORT_LEV} perps`, detail: `Margen $${shortMargin} → exposición $${shortMargin * SHORT_LEV}. Liq: $${shortLiq.toFixed(0)}`, protocol: 'Hyperliquid' },
            { n: 4, action: `LONG ${asset} x${LONG_LEV} hedge`, detail: `Margen $${longMargin} → exposición $${longMargin * LONG_LEV}. Liq: $${longLiq.toFixed(0)}`, protocol: 'Hyperliquid' },
        ];
        plan.exit_rules = [
            `SHORT x${SHORT_LEV} liq en $${shortLiq.toFixed(0)} (+${((shortLiq / price - 1) * 100).toFixed(0)}%) → cerrar antes`,
            `LONG x${LONG_LEV} liq en $${longLiq.toFixed(0)} (-${((1 - longLiq / price) * 100).toFixed(0)}%) → aceptar si E4 confirmada`,
            `Aave HF vigilar >1.3 (precio sube = deuda sube)`,
            'Si fase cambia a bull (5 días): CERRAR TODO',
        ];
        plan.warnings = [
            'LONG hedge SE VA A LIQUIDAR si la caída es fuerte (>30%) — es esperado y aceptable',
            `Cash restante: $${amount - supply - shortMargin - longMargin} (${((1 - (supply + shortMargin + longMargin) / amount) * 100).toFixed(0)}% reserva)`,
        ];

    } else {
        plan.steps = [
            { n: 1, action: 'Depositar USDC en Aave', detail: `$${amount} USDC → Aave V3 (${3.5}% APY)`, protocol: 'Aave' },
            { n: 2, action: 'ESPERAR', detail: `No abrir LP ni perps. Esperar confirmación de ${phase === 'accumulation' ? 'E2 (bull)' : 'E4 (bear)'}`, protocol: '—' },
        ];
        plan.exit_rules = [
            `Si confirma E2: ejecutar plan ALCISTA`,
            `Si confirma E4: ejecutar plan BAJISTA`,
            'Mientras: cobrar 3.5% APY en stables',
        ];
    }

    return plan;
}

// ═══════════════════════════════════════════════════════════════
// PERSIST ALERTS
// ═══════════════════════════════════════════════════════════════

function saveAlert(strategyId, alertType, message) {
    const db = getDb();
    db.prepare('INSERT INTO alert_log (strategy_id, alert_type, message) VALUES (?, ?, ?)').run(strategyId, alertType, message);
    db.close();
}

function getRecentAlerts(strategyId, limit = 50) {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM alert_log WHERE strategy_id = ? ORDER BY created_at DESC LIMIT ?').all(strategyId, limit);
    db.close();
    return rows;
}

function dismissAlert(alertId) {
    const db = getDb();
    db.prepare('UPDATE alert_log SET dismissed = 1 WHERE id = ?').run(alertId);
    db.close();
}

module.exports = { checkRules, generateActionPlan, saveAlert, getRecentAlerts, dismissAlert, ENTRY_RULES, EXIT_RULES };
