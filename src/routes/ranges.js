const express = require('express');
const router = express.Router();
const { getRangesForPair } = require('../services/ranges');
const { getDb } = require('../../db/init');

const VALID_PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'UNIUSDT', 'JUPUSDT', 'AAVEUSDT'];
const TF_MAP = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' };

function getCustomRanges(pair) {
    const db = getDb();
    const rows = db.prepare(
        'SELECT timeframe, sup, mid, res FROM custom_ranges WHERE pair = ? AND enabled = 1'
    ).all(pair);
    db.close();

    const map = {};
    for (const r of rows) map[r.timeframe] = { sup: r.sup, mid: r.mid, res: r.res };
    return map;
}

router.get('/', async (req, res) => {
    const pair = (req.query.pair || '').toUpperCase();
    if (!VALID_PAIRS.includes(pair)) {
        return res.status(400).json({ error: 'Par no válido' });
    }

    try {
        const data = await getRangesForPair(pair);
        const custom = getCustomRanges(pair);

        for (const tf of ['daily', 'weekly', 'monthly']) {
            if (custom[tf] && data[tf]) {
                data[tf].sup = custom[tf].sup;
                data[tf].mid = custom[tf].mid;
                data[tf].res = custom[tf].res;
                data[tf]._custom = true;
            }
        }

        res.json(data);
    } catch (e) {
        console.error('Ranges error:', e);
        res.status(500).json({ error: 'Error al obtener rangos' });
    }
});

module.exports = router;
