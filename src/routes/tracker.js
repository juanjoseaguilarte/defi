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

// GET /api/tracker/history — list all saved strategies
router.get('/history', (req, res) => {
    const dt = getDeviceToken(req);
    const db = getDb();

    const strategies = db.prepare(
        'SELECT id, amount, market_phase, main_asset, status, created_at FROM executed_strategies WHERE device_token = ? ORDER BY id DESC LIMIT 50'
    ).all(dt);

    for (const s of strategies) {
        const steps = db.prepare(
            'SELECT step_num, done, entry_price, lp_range_low, lp_range_high, executed_at FROM executed_steps WHERE strategy_id = ?'
        ).all(s.id);
        s.steps_total = steps.length;
        s.steps_done = steps.filter(st => st.done).length;
    }

    db.close();
    res.json({ ok: true, strategies });
});

// GET /api/tracker/:id — get a specific strategy by id
router.get('/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const db = getDb();
    const strategy = db.prepare('SELECT * FROM executed_strategies WHERE id = ?').get(id);
    if (!strategy) { db.close(); return res.status(404).json({ error: 'Estrategia no encontrada' }); }

    const steps = db.prepare('SELECT * FROM executed_steps WHERE strategy_id = ? ORDER BY step_num').all(id);
    db.close();

    res.json({
        ok: true,
        strategy: { ...strategy, strategy_json: JSON.parse(strategy.strategy_json || '{}') },
        steps,
    });
});

// POST /api/tracker/close — close the active strategy
router.post('/close', (req, res) => {
    const dt = req.body.device_token;
    const db = getDb();
    db.prepare("UPDATE executed_strategies SET status = 'closed' WHERE device_token = ? AND status = 'active'").run(dt);
    db.close();
    res.json({ ok: true });
});

// DELETE /api/tracker/:id — delete a strategy permanently
router.delete('/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const db = getDb();
    db.prepare('DELETE FROM alert_log WHERE strategy_id = ?').run(id);
    db.prepare('DELETE FROM executed_steps WHERE strategy_id = ?').run(id);
    db.prepare('DELETE FROM executed_strategies WHERE id = ?').run(id);
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
    const price = req.query.price ? parseFloat(req.query.price) : null;
    const strategyData = JSON.parse(strategy.strategy_json || '{}');
    const savedPhase = strategy.market_phase || '';
    const mainAsset = strategy.main_asset || 'ETH';

    // ── LP Range alerts ──
    for (const step of steps) {
        if (step.lp_range_low && step.lp_range_high && price) {
            const rangeWidth = step.lp_range_high - step.lp_range_low;
            const threshold = rangeWidth * 0.10;

            if (price < step.lp_range_low || price > step.lp_range_high) {
                newAlerts.push({
                    type: 'lp_out_of_range', severity: 'critical',
                    message: `PRECIO FUERA DE RANGO LP (paso ${step.step_num}). Rango: $${step.lp_range_low.toFixed(0)} — $${step.lp_range_high.toFixed(0)}. Precio: $${price.toFixed(0)}. Acción: retirar LP y rebalancear rango.`,
                });
            } else if (price <= step.lp_range_low + threshold) {
                newAlerts.push({
                    type: 'lp_range', severity: 'high',
                    message: `Precio ($${price.toFixed(0)}) cerca del límite inferior del rango LP ($${step.lp_range_low.toFixed(0)}). Preparar rebalanceo.`,
                });
            } else if (price >= step.lp_range_high - threshold) {
                newAlerts.push({
                    type: 'lp_range', severity: 'high',
                    message: `Precio ($${price.toFixed(0)}) cerca del límite superior del rango LP ($${step.lp_range_high.toFixed(0)}). Preparar rebalanceo.`,
                });
            }
        }

        // ── Stop Loss / Take Profit alerts ──
        if (step.entry_price && price && step.direction) {
            const entry = step.entry_price;
            const pnlPct = step.direction === 'LONG'
                ? ((price - entry) / entry * 100)
                : ((entry - price) / entry * 100);
            const lev = step.leverage || 1;

            // Take profit: >15% profit on position
            if (pnlPct * lev > 50) {
                newAlerts.push({
                    type: 'take_profit', severity: 'high',
                    message: `${step.direction} ${mainAsset} (paso ${step.step_num}): +${(pnlPct * lev).toFixed(0)}% beneficio. Entrada: $${entry.toFixed(0)}, Actual: $${price.toFixed(0)}. Acción: considerar recoger beneficios parciales.`,
                });
            } else if (pnlPct * lev > 25) {
                newAlerts.push({
                    type: 'take_profit', severity: 'medium',
                    message: `${step.direction} ${mainAsset} (paso ${step.step_num}): +${(pnlPct * lev).toFixed(0)}% beneficio. Considerar mover stop loss a breakeven.`,
                });
            }

            // Stop loss warning
            if (pnlPct * lev < -30) {
                newAlerts.push({
                    type: 'stop_loss', severity: 'critical',
                    message: `${step.direction} ${mainAsset} (paso ${step.step_num}): ${(pnlPct * lev).toFixed(0)}% pérdida. Entrada: $${entry.toFixed(0)}, Actual: $${price.toFixed(0)}. Acción: cerrar posición o ajustar stop loss.`,
                });
            }
        }
    }

    // ── Phase change detection ──
    try {
        const analystResp = await fetch('http://localhost:' + (process.env.PORT || 3000) + '/api/analyst');
        if (analystResp.ok) {
            const analystData = await analystResp.json();
            const currentPhases = {};
            for (const coin of ['BTC', 'ETH']) {
                currentPhases[coin] = analystData.results?.[coin]?.['Diario']?.type || 'accumulation';
            }

            const currentMainPhase = currentPhases[mainAsset] || 'accumulation';
            const phaseLabels = { bull: 'E2 Alcista', bear: 'E4 Bajista', distribution: 'E3 Distribución', accumulation: 'E1 Acumulación' };

            // Check if the phase changed from when strategy was created
            const wasBearish = savedPhase.includes('BAJISTA') || savedPhase.includes('E4');
            const wasBullish = savedPhase.includes('ALCISTA') || savedPhase.includes('E2');
            const wasDistribution = savedPhase.includes('DISTRIBUCIÓN') || savedPhase.includes('E3');
            const wasAccumulation = savedPhase.includes('ACUMULACIÓN') || savedPhase.includes('E1');

            if (wasBearish && currentMainPhase !== 'bear') {
                newAlerts.push({
                    type: 'phase_change', severity: 'critical',
                    message: `CAMBIO DE ETAPA: ${mainAsset} pasó de E4 Bajista a ${phaseLabels[currentMainPhase]}. Acción recomendada: cerrar shorts, rotar estrategia a ${phaseLabels[currentMainPhase]}.`,
                });
            }
            if (wasBullish && currentMainPhase !== 'bull') {
                newAlerts.push({
                    type: 'phase_change', severity: 'critical',
                    message: `CAMBIO DE ETAPA: ${mainAsset} pasó de E2 Alcista a ${phaseLabels[currentMainPhase]}. Acción recomendada: cerrar longs, reducir LP leverage, tomar beneficios.`,
                });
            }
            if (wasAccumulation && currentMainPhase === 'bull') {
                newAlerts.push({
                    type: 'phase_change', severity: 'high',
                    message: `${mainAsset} confirmó E2 Alcista. Acción: desplegar reserva USDC, cerrar short de cobertura, ampliar LP, considerar LONG.`,
                });
            }
            if (wasAccumulation && currentMainPhase === 'bear') {
                newAlerts.push({
                    type: 'phase_change', severity: 'critical',
                    message: `${mainAsset} volvió a E4 Bajista. Acción: cerrar LP inmediatamente, ampliar shorts, mover capital a stables.`,
                });
            }
            if (wasDistribution && currentMainPhase === 'bear') {
                newAlerts.push({
                    type: 'phase_change', severity: 'high',
                    message: `${mainAsset} confirmó E4 Bajista. Acción: mantener shorts, el short sintético (borrow+venta) está generando. Considerar ampliar posición bajista.`,
                });
            }
            if (wasDistribution && currentMainPhase === 'bull') {
                newAlerts.push({
                    type: 'phase_change', severity: 'critical',
                    message: `${mainAsset} volvió a E2 Alcista inesperadamente. Acción: cerrar shorts inmediatamente, recomprar borrow, rotar a estrategia alcista.`,
                });
            }
        }
    } catch (_) {}

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
