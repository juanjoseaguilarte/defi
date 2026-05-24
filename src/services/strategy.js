const { fetchAllPrices } = require('./binance');

const STABLECOINS = ['USDC', 'USDT', 'DAI', 'FRAX'];

async function tryFetch(url, timeoutMs = 10000) {
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

async function tryPost(url, body, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

// ═══════════════════════════════════════════════════════════════
// DATA FETCHERS
// ═══════════════════════════════════════════════════════════════

async function fetchDefiLlamaPools() {
    try {
        const data = await tryFetch('https://yields.llama.fi/pools');
        if (!data?.data) return [];
        return data.data.filter(p =>
            p.chain === 'Arbitrum' &&
            p.tvlUsd > 100000 &&
            p.apy > 0
        );
    } catch (_) {
        return [];
    }
}

async function fetchGMXFunding() {
    try {
        const data = await tryFetch('https://arbitrum-api.gmxinfra.io/signed_prices/funding_rates');
        if (!data) return [];

        const markets = [];
        for (const [market, info] of Object.entries(data)) {
            if (info?.longsPayShorts !== undefined) {
                markets.push({
                    market,
                    longsPayShorts: info.longsPayShorts,
                    fundingRateHourly: parseFloat(info.fundingRate || 0),
                    annualizedRate: parseFloat(info.fundingRate || 0) * 8760,
                });
            }
        }
        return markets;
    } catch (_) {
        try {
            const data = await tryFetch('https://arbitrum-api.gmxinfra.io/markets/info');
            return Array.isArray(data) ? data : [];
        } catch (__) {
            return [];
        }
    }
}

async function fetchHyperliquidFunding() {
    try {
        const data = await tryPost('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' });
        if (!Array.isArray(data) || data.length < 2) return [];

        const meta = data[0];
        const ctxs = data[1];
        const results = [];

        for (let i = 0; i < ctxs.length; i++) {
            const ctx = ctxs[i];
            const name = meta.universe?.[i]?.name;
            if (!name || !ctx.funding) continue;

            results.push({
                coin: name,
                fundingRate: parseFloat(ctx.funding),
                annualizedRate: parseFloat(ctx.funding) * 8760,
                markPx: parseFloat(ctx.markPx || 0),
                openInterest: parseFloat(ctx.openInterest || 0),
            });
        }
        return results;
    } catch (_) {
        return [];
    }
}

function categorizePool(pool) {
    const proto = (pool.project || '').toLowerCase();
    const symbol = (pool.symbol || '').toUpperCase();

    if (proto.includes('aave')) return 'aave';
    if (proto.includes('uniswap') || proto.includes('camelot') || proto.includes('sushi') || proto.includes('curve') || proto.includes('balancer')) return 'lp';
    if (proto.includes('gmx') || proto.includes('perp')) return 'perps';
    if (proto.includes('revert') || proto.includes('arrakis') || proto.includes('gamma')) return 'managed_lp';
    return 'other';
}

function isStablePair(symbol) {
    const parts = (symbol || '').toUpperCase().split('-');
    return parts.length >= 2 && parts.every(p => STABLECOINS.some(s => p.includes(s)));
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY GENERATION
// ═══════════════════════════════════════════════════════════════

function generateStrategies(amount, pools, gmxFunding, hlFunding, trend) {
    const strategies = [];

    // ── 1) Stablecoin LP (lowest risk) ──
    const stableLPs = pools
        .filter(p => isStablePair(p.symbol) && p.apy > 1 && p.tvlUsd > 500000)
        .sort((a, b) => b.apy - a.apy)
        .slice(0, 3);

    for (const pool of stableLPs) {
        strategies.push({
            name: `LP Stablecoin — ${pool.symbol}`,
            protocol: pool.project,
            type: 'lp_stable',
            riskLevel: 'bajo',
            riskScore: 1,
            apy: pool.apy,
            apyBase: pool.apyBase || 0,
            apyReward: pool.apyReward || 0,
            tvl: pool.tvlUsd,
            allocation: amount,
            deltaNeutral: true,
            description: `Proveer liquidez en el par ${pool.symbol} en ${pool.project}. Ambos activos son stablecoins, sin exposición a volatilidad.`,
            steps: [
                `Depositar ${(amount / 2).toFixed(0)} USD en cada stablecoin del par`,
                `Ir a ${pool.project} en Arbitrum`,
                `Añadir liquidez al pool ${pool.symbol}`,
                `Recoger fees periódicamente`,
            ],
            risks: ['Riesgo de depeg de stablecoin', 'Riesgo de smart contract'],
        });
    }

    // ── 2) Aave Supply (low risk) ──
    const aavePools = pools
        .filter(p => (p.project || '').toLowerCase().includes('aave') && p.apy > 0.5)
        .sort((a, b) => b.apy - a.apy)
        .slice(0, 5);

    for (const pool of aavePools) {
        const isStable = STABLECOINS.some(s => (pool.symbol || '').toUpperCase().includes(s));
        strategies.push({
            name: `Aave Supply — ${pool.symbol}`,
            protocol: 'Aave V3',
            type: 'aave_supply',
            riskLevel: isStable ? 'bajo' : 'medio',
            riskScore: isStable ? 1 : 2,
            apy: pool.apy,
            apyBase: pool.apyBase || 0,
            apyReward: pool.apyReward || 0,
            tvl: pool.tvlUsd,
            allocation: amount,
            deltaNeutral: isStable,
            description: `Depositar ${pool.symbol} en Aave V3 Arbitrum. ${isStable ? 'Sin exposición direccional.' : 'Exposición al precio de ' + pool.symbol + '.'}`,
            steps: [
                `Comprar ${pool.symbol} por valor de ${amount.toFixed(0)} USD`,
                'Ir a app.aave.com → Arbitrum',
                `Supply ${pool.symbol}`,
                'Monitorizar Health Factor si se usa como colateral',
            ],
            risks: isStable
                ? ['Riesgo de smart contract', 'Riesgo de depeg']
                : ['Riesgo de smart contract', 'Riesgo de precio del activo'],
        });
    }

    // ── 3) Aave Stablecoin Loop (medium risk) ──
    const aaveStableSupply = aavePools.filter(p => STABLECOINS.some(s => (p.symbol || '').toUpperCase().includes(s)));
    if (aaveStableSupply.length >= 1) {
        const best = aaveStableSupply[0];
        const leverage = 3;
        const effectiveApy = best.apy * leverage * 0.7;

        strategies.push({
            name: `Aave Loop — ${best.symbol} x${leverage}`,
            protocol: 'Aave V3',
            type: 'aave_loop',
            riskLevel: 'medio',
            riskScore: 3,
            apy: effectiveApy,
            apyBase: effectiveApy,
            apyReward: 0,
            tvl: best.tvlUsd,
            allocation: amount,
            deltaNeutral: true,
            description: `Loop de stablecoins en Aave: depositar ${best.symbol}, pedir prestado otra stable, re-depositar. Apalancamiento ~${leverage}x sobre el yield base.`,
            steps: [
                `Depositar ${amount.toFixed(0)} USD en ${best.symbol} en Aave`,
                `Pedir prestado ~${(amount * 0.7).toFixed(0)} USD en otra stablecoin (USDC/USDT)`,
                'Re-depositar lo prestado',
                `Repetir hasta ~${leverage}x apalancamiento`,
                'Mantener Health Factor > 1.5',
            ],
            risks: ['Riesgo de liquidación si HF < 1.0', 'Spread entre supply/borrow rate puede invertirse', 'Riesgo de depeg'],
        });
    }

    // ── 4) Funding Rate Arbitrage (medium-high risk) ──
    const fundingCoins = ['BTC', 'ETH', 'SOL'];
    for (const coin of fundingCoins) {
        const hlRate = hlFunding.find(f => f.coin === coin);
        if (!hlRate || Math.abs(hlRate.annualizedRate) < 5) continue;

        const isPositive = hlRate.fundingRate > 0;
        const annualized = Math.abs(hlRate.annualizedRate);
        const direction = isPositive ? 'Longs pagan a Shorts' : 'Shorts pagan a Longs';

        strategies.push({
            name: `Funding Arb — ${coin} (${isPositive ? 'Short Perp' : 'Long Perp'})`,
            protocol: 'Hyperliquid + Spot',
            type: 'funding_arb',
            riskLevel: 'medio-alto',
            riskScore: 4,
            apy: annualized,
            apyBase: annualized,
            apyReward: 0,
            tvl: hlRate.openInterest * hlRate.markPx,
            allocation: amount,
            deltaNeutral: true,
            description: `Arbitraje de funding rate en ${coin}. ${direction} → cobras funding. Posición delta-neutral: ${isPositive ? 'compra spot + short en perps' : 'vende spot + long en perps'}.`,
            steps: isPositive ? [
                `Comprar ${(amount / 2).toFixed(0)} USD en ${coin} spot`,
                `Abrir short de ${(amount / 2).toFixed(0)} USD en ${coin}-PERP en Hyperliquid`,
                `Funding rate actual: ${(hlRate.fundingRate * 100).toFixed(4)}% por hora`,
                'Monitorizar que el funding siga positivo',
                'Cerrar ambas posiciones cuando funding se invierta',
            ] : [
                `Vender/shortear ${(amount / 2).toFixed(0)} USD en ${coin} spot (o via Aave borrow)`,
                `Abrir long de ${(amount / 2).toFixed(0)} USD en ${coin}-PERP en Hyperliquid`,
                `Funding rate actual: ${(Math.abs(hlRate.fundingRate) * 100).toFixed(4)}% por hora`,
                'Monitorizar que el funding siga negativo',
            ],
            risks: ['Funding rate puede cambiar de signo', 'Riesgo de liquidación en perps', 'Slippage en apertura/cierre', 'Riesgo de exchange (Hyperliquid)'],
        });
    }

    // ── 5) Hedged LP (medium-high risk) ──
    const volatileLPs = pools
        .filter(p => {
            const cat = categorizePool(p);
            return (cat === 'lp' || cat === 'managed_lp') &&
                !isStablePair(p.symbol) &&
                p.apy > 10 &&
                p.tvlUsd > 500000;
        })
        .sort((a, b) => b.apy - a.apy)
        .slice(0, 3);

    for (const pool of volatileLPs) {
        const hedgeCost = 8;
        const netApy = Math.max(0, pool.apy - hedgeCost);

        strategies.push({
            name: `LP Hedged — ${pool.symbol}`,
            protocol: pool.project + ' + Perps',
            type: 'hedged_lp',
            riskLevel: 'medio-alto',
            riskScore: 4,
            apy: netApy,
            apyBase: pool.apy,
            apyReward: -hedgeCost,
            tvl: pool.tvlUsd,
            allocation: amount,
            deltaNeutral: true,
            description: `Proveer liquidez en ${pool.symbol} (APY ${pool.apy.toFixed(1)}%) y cubrir la exposición direccional con shorts en perps. Coste estimado del hedge: ~${hedgeCost}% anual.`,
            steps: [
                `Depositar ${(amount * 0.6).toFixed(0)} USD en el pool ${pool.symbol} en ${pool.project}`,
                `Abrir short por el valor del token volátil (~${(amount * 0.3).toFixed(0)} USD) en Hyperliquid/GMX`,
                'Rebalancear el hedge semanalmente según impermanent loss',
                'Recoger fees del pool periódicamente',
            ],
            risks: ['Impermanent loss no cubierto exactamente por el hedge', 'Coste de funding del short', 'Necesita rebalanceo activo', 'Riesgo de smart contract'],
        });
    }

    // ── 6) Managed LP / Revert Style (medium risk) ──
    const managedLPs = pools
        .filter(p => {
            const proto = (p.project || '').toLowerCase();
            return (proto.includes('arrakis') || proto.includes('gamma') || proto.includes('revert') || proto.includes('defiedge') || proto.includes('bunni')) &&
                p.chain === 'Arbitrum' && p.apy > 3 && p.tvlUsd > 200000;
        })
        .sort((a, b) => b.apy - a.apy)
        .slice(0, 3);

    for (const pool of managedLPs) {
        const isStable = isStablePair(pool.symbol);
        strategies.push({
            name: `Managed LP — ${pool.symbol}`,
            protocol: pool.project,
            type: 'managed_lp',
            riskLevel: isStable ? 'bajo' : 'medio',
            riskScore: isStable ? 2 : 3,
            apy: pool.apy,
            apyBase: pool.apyBase || 0,
            apyReward: pool.apyReward || 0,
            tvl: pool.tvlUsd,
            allocation: amount,
            deltaNeutral: isStable,
            description: `Liquidez gestionada automáticamente en ${pool.symbol} via ${pool.project}. ${isStable ? 'Par de stables, delta neutral.' : 'Exposición al precio del activo volátil.'} El protocolo rebalancea el rango automáticamente.`,
            steps: [
                `Ir a ${pool.project} en Arbitrum`,
                `Depositar ${amount.toFixed(0)} USD en el vault ${pool.symbol}`,
                'El protocolo gestiona el rango de liquidez automáticamente',
                'Retirar cuando desees',
            ],
            risks: isStable
                ? ['Riesgo de smart contract', 'Fee del protocolo de gestión']
                : ['Impermanent loss', 'Riesgo de smart contract', 'Fee del protocolo'],
        });
    }

    // Sort by risk-adjusted return
    strategies.sort((a, b) => {
        const scoreA = a.apy / (a.riskScore || 1);
        const scoreB = b.apy / (b.riskScore || 1);
        return scoreB - scoreA;
    });

    return strategies;
}

function buildPortfolio(amount, strategies, riskPreference) {
    if (strategies.length === 0) return { allocations: [], totalApy: 0 };

    const deltaNeutralOnly = strategies.filter(s => s.deltaNeutral);
    const pool = deltaNeutralOnly.length >= 3 ? deltaNeutralOnly : strategies;

    const top = pool.slice(0, 4);
    const weights = top.map((s, i) => 1 / (i + 1));
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    const allocations = top.map((s, i) => ({
        ...s,
        allocation: Math.round(amount * weights[i] / totalWeight),
        weight: (weights[i] / totalWeight * 100).toFixed(0) + '%',
    }));

    const totalApy = allocations.reduce((sum, a) => sum + a.apy * (a.allocation / amount), 0);

    return { allocations, totalApy };
}

// ═══════════════════════════════════════════════════════════════
// MAIN ENDPOINT
// ═══════════════════════════════════════════════════════════════

async function getStrategy(amount) {
    const [pools, gmxFunding, hlFunding] = await Promise.all([
        fetchDefiLlamaPools(),
        fetchGMXFunding(),
        fetchHyperliquidFunding(),
    ]);

    let trend = 'lateral';
    try {
        const prices = await fetchAllPrices();
        if (prices.BTCUSDT) trend = 'available';
    } catch (_) {}

    const strategies = generateStrategies(amount, pools, gmxFunding, hlFunding, trend);
    const portfolio = buildPortfolio(amount, strategies);

    return {
        amount,
        chain: 'Arbitrum',
        calculated_at: new Date().toISOString(),
        data_sources: {
            defillama_pools: pools.length,
            gmx_markets: gmxFunding.length,
            hyperliquid_coins: hlFunding.length,
        },
        portfolio,
        all_strategies: strategies,
    };
}

module.exports = { getStrategy };
