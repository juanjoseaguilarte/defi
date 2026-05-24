const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/init');
const { fetchAllPrices } = require('../services/binance');

const LTV = {
    BTC: 0.73,
    ETH: 0.80,
    SOL: 0.65,
    USDC: 0.93,
    USDT: 0.93,
};

function calcHealthFactor(collateralUsd, debtUsd, collCoin) {
    if (debtUsd <= 0) return 99;
    const ltv = LTV[collCoin] || 0.75;
    return (collateralUsd * ltv) / debtUsd;
}

router.get('/', async (req, res) => {
    const dt = req.query.device_token || 'unknown';
    const action = req.query.action || 'position';

    const db = getDb();

    if (action === 'actions') {
        const actions = db.prepare(
            'SELECT * FROM position_actions WHERE device_token = ? ORDER BY created_at DESC LIMIT 20'
        ).all(dt);
        db.close();
        return res.json({ ok: true, actions });
    }

    try {
        const pos = db.prepare(
            "SELECT * FROM positions WHERE device_token = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
        ).get(dt);

        if (!pos) {
            db.close();
            return res.json({ ok: true, position: null });
        }

        const prices = await fetchAllPrices();
        const collPrice = prices[pos.collateral_coin + 'USDT'] || (pos.collateral_coin === 'USDC' ? 1 : 0);
        const debtPrice = prices[pos.debt_coin + 'USDT'] || (pos.debt_coin === 'USDC' ? 1 : 0);

        const collUsd = pos.collateral_qty * collPrice;
        const debtUsd = pos.debt_qty * debtPrice;
        const hf = calcHealthFactor(collUsd, debtUsd, pos.collateral_coin);

        db.close();
        res.json({
            ok: true,
            position: pos,
            collateral_assets: [{ coin: pos.collateral_coin, qty: pos.collateral_qty, value_usd: collUsd }],
            debt_assets: [{ coin: pos.debt_coin, qty: pos.debt_qty, value_usd: debtUsd }],
            live: {
                collateral_usd: collUsd,
                debt_usd: debtUsd,
                health_factor: parseFloat(hf.toFixed(4)),
            },
        });
    } catch (e) {
        db.close();
        console.error('Aave error:', e);
        res.status(500).json({ ok: false, error: 'Error al obtener posición' });
    }
});

router.post('/', async (req, res) => {
    const body = req.body;
    const db = getDb();

    try {
        if (body.action === 'save_position') {
            const existing = db.prepare(
                "SELECT id FROM positions WHERE device_token = ? AND status = 'active'"
            ).get(body.device_token);

            if (existing) {
                db.prepare(`
                    UPDATE positions SET
                        collateral_coin = ?, collateral_qty = ?,
                        debt_coin = ?, debt_qty = ?,
                        hf_alert_threshold = ?, notes = ?,
                        updated_at = datetime('now')
                    WHERE id = ?
                `).run(
                    body.collateral_coin, body.collateral_qty,
                    body.debt_coin, body.debt_qty,
                    body.hf_alert_threshold || 1.80, body.notes || '',
                    existing.id
                );
            } else {
                db.prepare(`
                    INSERT INTO positions (device_token, collateral_coin, collateral_qty, debt_coin, debt_qty, hf_alert_threshold, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(
                    body.device_token,
                    body.collateral_coin, body.collateral_qty,
                    body.debt_coin, body.debt_qty,
                    body.hf_alert_threshold || 1.80, body.notes || ''
                );
            }

            db.prepare(`
                INSERT INTO position_actions (device_token, action_type, from_asset, to_asset, qty)
                VALUES (?, ?, ?, ?, ?)
            `).run(body.device_token, existing ? 'Editar posición' : 'Crear posición',
                body.collateral_coin, body.debt_coin, body.collateral_qty);

            db.close();
            return res.json({ ok: true });
        }

        if (body.action === 'close_position') {
            db.prepare(
                "UPDATE positions SET status = 'closed', updated_at = datetime('now') WHERE device_token = ? AND status = 'active'"
            ).run(body.device_token);

            db.prepare(`
                INSERT INTO position_actions (device_token, action_type)
                VALUES (?, 'Cerrar posición')
            `).run(body.device_token);

            db.close();
            return res.json({ ok: true });
        }

        if (body.action === 'update_hf_threshold') {
            db.prepare(
                "UPDATE positions SET hf_alert_threshold = ?, updated_at = datetime('now') WHERE device_token = ? AND status = 'active'"
            ).run(body.hf_alert_threshold, body.device_token);
            db.close();
            return res.json({ ok: true });
        }

        db.close();
        res.status(400).json({ ok: false, error: 'Acción no válida' });
    } catch (e) {
        db.close();
        console.error('Aave POST error:', e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
