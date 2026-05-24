const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/init');

function getDeviceToken(req) {
    return req.query.device_token || req.body?.device_token || 'unknown';
}

// GET /api/tracker — get active strategy with steps
router.get('/', (req, res) => {
    const dt = getDeviceToken(req);
    const db = getDb();

    const strategy = db.prepare(
        "SELECT * FROM executed_strategies WHERE device_token = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
    ).get(dt);

    if (!strategy) {
        db.close();
        return res.json({ ok: true, strategy: null });
    }

    const steps = db.prepare(
        'SELECT * FROM executed_steps WHERE strategy_id = ? ORDER BY step_num'
    ).all(strategy.id);

    const alerts = db.prepare(
        'SELECT * FROM alert_log WHERE strategy_id = ? AND dismissed = 0 ORDER BY id DESC LIMIT 20'
    ).all(strategy.id);

    db.close();

    res.json({
        ok: true,
        strategy: {
            ...strategy,
            strategy_json: JSON.parse(strategy.strategy_json || '{}'),
        },
        steps,
        alerts,
    });
});

// POST /api/tracker/save — save a new strategy execution
router.post('/save', (req, res) => {
    const { device_token, amount, market_phase, main_asset, strategy_json, steps } = req.body;
    if (!device_token || !amount) {
        return res.status(400).json({ error: 'device_token y amount requeridos' });
    }

    const db = getDb();

    db.prepare(
        "UPDATE executed_strategies SET status = 'closed' WHERE device_token = ? AND status = 'active'"
    ).run(device_token);

    const result = db.prepare(
        'INSERT INTO executed_strategies (device_token, amount, market_phase, main_asset, strategy_json) VALUES (?, ?, ?, ?, ?)'
    ).run(device_token, amount, market_phase || '', main_asset || '', JSON.stringify(strategy_json || {}));

    const strategyId = result.lastInsertRowid;

    if (steps && Array.isArray(steps)) {
        const stmt = db.prepare(
            'INSERT OR REPLACE INTO executed_steps (strategy_id, step_num, done, entry_price, lp_range_low, lp_range_high, leverage, direction, margin_amount, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        for (const s of steps) {
            stmt.run(strategyId, s.step_num, 0, null, null, null, s.leverage || null, s.direction || null, s.margin_amount || null, '');
        }
    }

    db.close();
    res.json({ ok: true, strategy_id: Number(strategyId) });
});

// POST /api/tracker/step — update a step (mark done, set entry price, range, etc.)
router.post('/step', (req, res) => {
    const { strategy_id, step_num, done, entry_price, lp_range_low, lp_range_high, leverage, direction, margin_amount, notes } = req.body;

    if (!strategy_id || !step_num) {
        return res.status(400).json({ error: 'strategy_id y step_num requeridos' });
    }

    const db = getDb();

    const existing = db.prepare(
        'SELECT id FROM executed_steps WHERE strategy_id = ? AND step_num = ?'
    ).get(strategy_id, step_num);

    if (existing) {
        const fields = [];
        const values = [];
        if (done !== undefined) { fields.push('done = ?'); values.push(done ? 1 : 0); }
        if (entry_price !== undefined) { fields.push('entry_price = ?'); values.push(entry_price); }
        if (lp_range_low !== undefined) { fields.push('lp_range_low = ?'); values.push(lp_range_low); }
        if (lp_range_high !== undefined) { fields.push('lp_range_high = ?'); values.push(lp_range_high); }
        if (leverage !== undefined) { fields.push('leverage = ?'); values.push(leverage); }
        if (direction !== undefined) { fields.push('direction = ?'); values.push(direction); }
        if (margin_amount !== undefined) { fields.push('margin_amount = ?'); values.push(margin_amount); }
        if (notes !== undefined) { fields.push('notes = ?'); values.push(notes); }
        if (done) { fields.push("executed_at = datetime('now')"); }

        if (fields.length > 0) {
            values.push(strategy_id, step_num);
            db.prepare(`UPDATE executed_steps SET ${fields.join(', ')} WHERE strategy_id = ? AND step_num = ?`).run(...values);
        }
    } else {
        db.prepare(
            'INSERT INTO executed_steps (strategy_id, step_num, done, entry_price, lp_range_low, lp_range_high, leverage, direction, margin_amount, notes, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(strategy_id, step_num, done ? 1 : 0, entry_price || null, lp_range_low || null, lp_range_high || null, leverage || null, direction || null, margin_amount || null, notes || '', done ? new Date().toISOString() : null);
    }

    db.close();
    res.json({ ok: true });
});

// POST /api/tracker/close — close the active strategy
router.post('/close', (req, res) => {
    const dt = req.body.device_token;
    const db = getDb();
    db.prepare("UPDATE executed_strategies SET status = 'closed' WHERE device_token = ? AND status = 'active'").run(dt);
    db.close();
    res.json({ ok: true });
});

// GET /api/tracker/check — check alerts for active strategy
router.get('/check', async (req, res) => {
    const dt = getDeviceToken(req);
    const db = getDb();

    const strategy = db.prepare(
        "SELECT * FROM executed_strategies WHERE device_token = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
    ).get(dt);

    if (!strategy) {
        db.close();
        return res.json({ ok: true, alerts: [] });
    }

    const steps = db.prepare(
        'SELECT * FROM executed_steps WHERE strategy_id = ? AND done = 1'
    ).all(strategy.id);

    const newAlerts = [];

    for (const step of steps) {
        // Alert: LP price near range boundary
        if (step.lp_range_low && step.lp_range_high && step.entry_price) {
            const rangeWidth = step.lp_range_high - step.lp_range_low;
            const threshold = rangeWidth * 0.10;

            if (req.query.price) {
                const price = parseFloat(req.query.price);
                if (price <= step.lp_range_low + threshold) {
                    newAlerts.push({
                        type: 'lp_range',
                        severity: 'high',
                        message: `Precio (${price.toFixed(2)}) cerca del límite inferior del rango LP (${step.lp_range_low.toFixed(2)}). Considera rebalancear.`,
                        step_num: step.step_num,
                    });
                }
                if (price >= step.lp_range_high - threshold) {
                    newAlerts.push({
                        type: 'lp_range',
                        severity: 'high',
                        message: `Precio (${price.toFixed(2)}) cerca del límite superior del rango LP (${step.lp_range_high.toFixed(2)}). Considera rebalancear.`,
                        step_num: step.step_num,
                    });
                }
                if (price < step.lp_range_low || price > step.lp_range_high) {
                    newAlerts.push({
                        type: 'lp_out_of_range',
                        severity: 'critical',
                        message: `PRECIO FUERA DE RANGO LP. Rango: ${step.lp_range_low.toFixed(2)} - ${step.lp_range_high.toFixed(2)}. Precio actual: ${price.toFixed(2)}. Tu LP no está generando fees.`,
                        step_num: step.step_num,
                    });
                }
            }
        }
    }

    // Save new alerts
    const insertAlert = db.prepare(
        'INSERT INTO alert_log (strategy_id, alert_type, message) VALUES (?, ?, ?)'
    );
    for (const a of newAlerts) {
        const exists = db.prepare(
            "SELECT id FROM alert_log WHERE strategy_id = ? AND alert_type = ? AND dismissed = 0 AND created_at > datetime('now', '-1 hour')"
        ).get(strategy.id, a.type);
        if (!exists) {
            insertAlert.run(strategy.id, a.type, a.message);
        }
    }

    const allAlerts = db.prepare(
        'SELECT * FROM alert_log WHERE strategy_id = ? AND dismissed = 0 ORDER BY id DESC LIMIT 10'
    ).all(strategy.id);

    db.close();
    res.json({ ok: true, alerts: allAlerts });
});

// POST /api/tracker/dismiss — dismiss an alert
router.post('/dismiss', (req, res) => {
    const { alert_id } = req.body;
    const db = getDb();
    db.prepare('UPDATE alert_log SET dismissed = 1 WHERE id = ?').run(alert_id);
    db.close();
    res.json({ ok: true });
});

module.exports = router;
