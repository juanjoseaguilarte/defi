const express = require('express');
const router = express.Router();
const { getDailyTrade } = require('../services/daytrader');
const { sendTelegram } = require('../services/notify');
const { getDb } = require('../../db/init');

function fmtP(v) {
    if (!v || v === 0) return '—';
    if (v > 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (v > 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

// GET /api/daytrader?asset=ETH
router.get('/', async (req, res) => {
    const asset = (req.query.asset || 'ETH').toUpperCase();
    if (!['BTC', 'ETH', 'SOL'].includes(asset)) {
        return res.status(400).json({ error: 'Asset: BTC, ETH o SOL' });
    }
    try {
        const trade = await getDailyTrade(asset);
        res.json(trade);
    } catch (e) {
        console.error('Daytrader error:', e);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/daytrader/save — Save a signal to history
router.post('/save', (req, res) => {
    const { device_token, trade } = req.body;
    if (!device_token || !trade) return res.status(400).json({ error: 'device_token and trade required' });

    const db = getDb();
    const stmt = db.prepare(`INSERT INTO daytrade_signals
        (device_token, asset, signal, confidence, score, entry_price, tp, sl, rr, leverage, liq_price, max_hold_hours, exit_by, signal_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = stmt.run(
        device_token, trade.asset, trade.signal, trade.confidence, trade.score,
        trade.entry, trade.tp, trade.sl, trade.rr, trade.leverage, trade.liqPrice,
        trade.maxHoldHours, trade.exitBy, JSON.stringify(trade),
    );
    db.close();
    res.json({ ok: true, id: info.lastInsertRowid });
});

// POST /api/daytrader/close — Close a signal with result
router.post('/close', (req, res) => {
    const { id, result, closed_price, pnl_pct } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const db = getDb();
    db.prepare(`UPDATE daytrade_signals SET status = 'closed', result = ?, closed_price = ?, pnl_pct = ?, closed_at = datetime('now') WHERE id = ?`)
        .run(result || 'manual', closed_price || 0, pnl_pct || 0, id);
    db.close();

    const icon = result === 'tp' ? '✅' : result === 'sl' ? '❌' : '⏹';
    const label = result === 'tp' ? 'TAKE PROFIT' : result === 'sl' ? 'STOP LOSS' : 'CERRADO MANUAL';
    sendTelegram(`${icon} *${label}*\nPrecio cierre: $${fmtP(closed_price)}\nP&L: ${pnl_pct >= 0 ? '+' : ''}${pnl_pct?.toFixed(1) || 0}%`);

    res.json({ ok: true });
});

// POST /api/daytrader/enter — Mark that user entered the trade
router.post('/enter', (req, res) => {
    const { id, entry_price, tp, sl, leverage, margin } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const db = getDb();
    const updates = [];
    const params = [];

    updates.push("status = 'tracking'");
    if (entry_price) { updates.push('entry_price = ?'); params.push(entry_price); }
    if (tp) { updates.push('tp = ?'); params.push(tp); }
    if (sl) { updates.push('sl = ?'); params.push(sl); }
    if (leverage) { updates.push('leverage = ?'); params.push(leverage); }

    params.push(id);
    db.prepare(`UPDATE daytrade_signals SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    db.close();

    const dir = req.body.signal || '?';
    const asset = req.body.asset || '?';
    sendTelegram([
        `📍 *Entrada confirmada: ${dir} ${asset}*`,
        '',
        `*Entrada:* $${fmtP(entry_price)}`,
        `*Take Profit:* $${fmtP(tp)}`,
        `*Stop Loss:* $${fmtP(sl)}`,
        `*Leverage:* x${leverage}`,
        margin ? `*Margen:* $${margin}` : '',
        '',
        'Te aviso cuando toque TP o SL.',
    ].filter(Boolean).join('\n'));

    res.json({ ok: true });
});

// GET /api/daytrader/tracking — Get active trades being tracked
router.get('/tracking', (req, res) => {
    const dt = req.query.device_token;
    if (!dt) return res.status(400).json({ error: 'device_token required' });

    const db = getDb();
    const trades = db.prepare("SELECT * FROM daytrade_signals WHERE device_token = ? AND status = 'tracking' ORDER BY created_at DESC").all(dt);
    db.close();
    res.json({ ok: true, trades });
});

// POST /api/daytrader/check-tracking — Check if any tracked trade hit TP/SL
router.post('/check-tracking', async (req, res) => {
    const { device_token } = req.body;
    if (!device_token) return res.status(400).json({ error: 'device_token required' });

    const db = getDb();
    const trades = db.prepare("SELECT * FROM daytrade_signals WHERE device_token = ? AND status = 'tracking'").all(device_token);

    const alerts = [];
    const { fetchAllPrices } = require('../services/binance');
    let prices;
    try { prices = await fetchAllPrices(); } catch (_) { db.close(); return res.json({ ok: true, alerts: [] }); }

    for (const t of trades) {
        const pair = t.asset + 'USDT';
        const price = prices[pair];
        if (!price) continue;

        const isLong = t.signal === 'LONG';
        const pnlPct = isLong
            ? ((price - t.entry_price) / t.entry_price * t.leverage * 100)
            : ((t.entry_price - price) / t.entry_price * t.leverage * 100);

        let alert = null;

        if (isLong && price >= t.tp) {
            alert = { id: t.id, type: 'tp', asset: t.asset, signal: t.signal, price, pnlPct, message: `TP alcanzado: ${t.asset} $${fmtP(price)}` };
        } else if (isLong && price <= t.sl) {
            alert = { id: t.id, type: 'sl', asset: t.asset, signal: t.signal, price, pnlPct, message: `SL tocado: ${t.asset} $${fmtP(price)}` };
        } else if (!isLong && price <= t.tp) {
            alert = { id: t.id, type: 'tp', asset: t.asset, signal: t.signal, price, pnlPct, message: `TP alcanzado: ${t.asset} $${fmtP(price)}` };
        } else if (!isLong && price >= t.sl) {
            alert = { id: t.id, type: 'sl', asset: t.asset, signal: t.signal, price, pnlPct, message: `SL tocado: ${t.asset} $${fmtP(price)}` };
        } else {
            // Warn at 70% of way to TP or SL
            const distToTp = Math.abs(price - t.tp);
            const distToSl = Math.abs(price - t.sl);
            const totalRange = Math.abs(t.tp - t.sl);
            if (totalRange > 0) {
                if (distToTp / totalRange < 0.3) {
                    alert = { id: t.id, type: 'near_tp', asset: t.asset, signal: t.signal, price, pnlPct, message: `Cerca de TP: ${t.asset} $${fmtP(price)} (${pnlPct.toFixed(1)}%)` };
                } else if (distToSl / totalRange < 0.3) {
                    alert = { id: t.id, type: 'near_sl', asset: t.asset, signal: t.signal, price, pnlPct, message: `Cerca de SL: ${t.asset} $${fmtP(price)} (${pnlPct.toFixed(1)}%)` };
                }
            }
        }

        // Check expired
        if (!alert && t.exit_by) {
            const exitTime = new Date(t.exit_by).getTime();
            const remaining = exitTime - Date.now();
            if (remaining < 0) {
                alert = { id: t.id, type: 'expired', asset: t.asset, signal: t.signal, price, pnlPct, message: `Tiempo expirado: ${t.asset} — cerrar manualmente (${pnlPct.toFixed(1)}%)` };
            } else if (remaining < 30 * 60 * 1000) {
                alert = { id: t.id, type: 'expiring', asset: t.asset, signal: t.signal, price, pnlPct, message: `Quedan ${Math.round(remaining / 60000)} min: ${t.asset} (${pnlPct.toFixed(1)}%)` };
            }
        }

        if (alert) {
            alert.entry = t.entry_price;
            alert.tp = t.tp;
            alert.sl = t.sl;
            alert.leverage = t.leverage;
            alerts.push(alert);
        }
    }

    db.close();
    res.json({ ok: true, alerts });
});

// GET /api/daytrader/history?device_token=xxx&limit=30
router.get('/history', (req, res) => {
    const dt = req.query.device_token;
    const limit = parseInt(req.query.limit) || 30;
    if (!dt) return res.status(400).json({ error: 'device_token required' });

    const db = getDb();
    const signals = db.prepare('SELECT * FROM daytrade_signals WHERE device_token = ? ORDER BY created_at DESC LIMIT ?').all(dt, limit);
    db.close();

    const stats = {
        total: signals.length,
        wins: signals.filter(s => s.result === 'tp').length,
        losses: signals.filter(s => s.result === 'sl').length,
        open: signals.filter(s => s.status === 'open').length,
    };
    stats.winRate = stats.total > 0 ? ((stats.wins / (stats.wins + stats.losses || 1)) * 100).toFixed(0) : '—';

    res.json({ ok: true, signals, stats });
});

// GET /api/daytrader/alerts?device_token=xxx&limit=50
router.get('/alerts', (req, res) => {
    const dt = req.query.device_token;
    const limit = parseInt(req.query.limit) || 50;
    if (!dt) return res.status(400).json({ error: 'device_token required' });

    const db = getDb();
    const alerts = db.prepare('SELECT * FROM daytrade_alerts WHERE device_token = ? ORDER BY created_at DESC LIMIT ?').all(dt, limit);
    db.close();
    res.json({ ok: true, alerts });
});

// POST /api/daytrader/watch — Telegram notifications for watch mode
router.post('/watch', async (req, res) => {
    const { asset, action, trade, device_token } = req.body;

    if (action === 'start') {
        const assets = req.body.assets || [asset];
        await sendTelegram(`👀 *Vigilancia activada: ${assets.join(', ')}*\nCheckeando cada 3 min. Te aviso cuando haya señal.`);
        return res.json({ ok: true });
    }

    if (action === 'stop') {
        await sendTelegram('⏹ *Vigilancia detenida*');
        return res.json({ ok: true });
    }

    if (action === 'signal' && trade) {
        const dir = trade.signal;
        const icon = dir === 'LONG' ? '🟢' : '🔴';
        const msg = [
            `${icon} *${dir} ${trade.asset}*`,
            '',
            `*Entrada:* $${fmtP(trade.entry)}`,
            `*Take Profit:* $${fmtP(trade.tp)} (+${trade.tpDistPct}%)`,
            `*Stop Loss:* $${fmtP(trade.sl)} (-${trade.slDistPct}%)`,
            `*R:R:* ${trade.rr} | *Leverage:* x${trade.leverage}`,
            `*Confianza:* ${trade.confidence.toUpperCase()} (score ${trade.score})`,
            '',
            `*Liquidación:* $${fmtP(trade.liqPrice)}`,
            `*Ganancia:* ${trade.potentialPnl.win} / *Pérdida:* ${trade.potentialPnl.loss}`,
            `*Cerrar antes de:* ${new Date(trade.exitBy).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`,
            '',
            `⚠️ *NO usar más de x${trade.leverage}*`,
        ].join('\n');

        const tgOk = await sendTelegram(msg);

        // Save alert to DB
        const db = getDb();
        db.prepare('INSERT INTO daytrade_alerts (device_token, asset, signal, message, sent_telegram, sent_browser) VALUES (?, ?, ?, ?, ?, ?)')
            .run(device_token || 'unknown', trade.asset, dir, `${dir} ${trade.asset} a $${fmtP(trade.entry)} | TP $${fmtP(trade.tp)} SL $${fmtP(trade.sl)}`, tgOk ? 1 : 0, 1);

        // Auto-save signal to history
        if (device_token) {
            db.prepare(`INSERT INTO daytrade_signals
                (device_token, asset, signal, confidence, score, entry_price, tp, sl, rr, leverage, liq_price, max_hold_hours, exit_by, signal_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(device_token, trade.asset, dir, trade.confidence, trade.score,
                    trade.entry, trade.tp, trade.sl, trade.rr, trade.leverage, trade.liqPrice,
                    trade.maxHoldHours, trade.exitBy, JSON.stringify(trade));
        }
        db.close();

        return res.json({ ok: true });
    }

    res.json({ ok: true });
});

module.exports = router;
