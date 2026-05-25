const express = require('express');
const router = express.Router();
const { checkRules, generateActionPlan, getRecentAlerts, dismissAlert, ENTRY_RULES, EXIT_RULES } = require('../services/rules');
const { getDb } = require('../../db/init');

// GET /api/rules — All entry/exit rules definition
router.get('/', (req, res) => {
    res.json({
        entry_rules: ENTRY_RULES,
        exit_rules: EXIT_RULES,
        parameters: {
            short_leverage: 7,
            long_leverage: 3,
            lp_leverage: 2.5,
            lp_range: { down: '20%', up: '25%' },
            cooldown_days: 5,
            sizing: {
                bull: 'LP base 30% x2.5 = 75% total',
                bear: 'Supply 65% + SHORT 15% + LONG hedge 17% + reserva 3%',
                accumulation: '100% stables Aave',
                distribution: '100% stables Aave',
            },
        },
    });
});

// GET /api/rules/check — Live alert check
router.get('/check', async (req, res) => {
    try {
        let activeStrategy = null;
        const deviceToken = req.query.device;
        if (deviceToken) {
            const db = getDb();
            const strat = db.prepare("SELECT * FROM executed_strategies WHERE device_token = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(deviceToken);
            if (strat) {
                const steps = db.prepare('SELECT * FROM executed_steps WHERE strategy_id = ? ORDER BY step_num').all(strat.id);
                activeStrategy = {
                    id: strat.id,
                    market_phase: strat.market_phase,
                    main_asset: strat.main_asset,
                    amount: strat.amount,
                    steps: steps.map(s => ({
                        ...s,
                        done: !!s.done,
                        entry_asset: strat.main_asset,
                    })),
                };
            }
            db.close();
        }

        const result = await checkRules(activeStrategy);
        res.json(result);
    } catch (e) {
        console.error('Rules check error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/rules/plan?phase=bull&amount=10000&price=2500&asset=ETH
router.get('/plan', (req, res) => {
    const { phase, amount, price, asset } = req.query;
    if (!phase || !amount || !price || !asset) {
        return res.status(400).json({ error: 'Params required: phase, amount, price, asset' });
    }
    const plan = generateActionPlan(phase, parseFloat(amount), parseFloat(price), asset);
    if (!plan) return res.status(400).json({ error: 'Phase not recognized' });
    res.json(plan);
});

// GET /api/rules/alerts?strategy_id=1
router.get('/alerts', (req, res) => {
    const strategyId = parseInt(req.query.strategy_id) || 0;
    if (!strategyId) return res.status(400).json({ error: 'strategy_id required' });
    const alerts = getRecentAlerts(strategyId);
    res.json({ alerts });
});

// POST /api/rules/alerts/:id/dismiss
router.post('/alerts/:id/dismiss', (req, res) => {
    dismissAlert(parseInt(req.params.id));
    res.json({ ok: true });
});

module.exports = router;
