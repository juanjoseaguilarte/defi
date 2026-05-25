const express = require('express');
const router = express.Router();
const { getDailyTrade } = require('../services/daytrader');
const { sendTelegram } = require('../services/notify');

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

function fmtP(v) {
    if (!v || v === 0) return '—';
    if (v > 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (v > 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

// POST /api/daytrader/watch — Telegram notifications for watch mode
router.post('/watch', async (req, res) => {
    const { asset, action, trade } = req.body;

    if (action === 'start') {
        await sendTelegram(`👀 *Vigilancia activada: ${asset}*\nCheckeando cada 3 min. Te aviso cuando haya señal.`);
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
        ].join('\n');

        await sendTelegram(msg);
        return res.json({ ok: true });
    }

    res.json({ ok: true });
});

module.exports = router;
