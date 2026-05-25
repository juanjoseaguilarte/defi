const { pyDaytrader } = require('./pybridge');

async function getDailyTrade(asset) {
    try {
        return await pyDaytrader(asset);
    } catch (e) {
        return {
            signal: 'ERROR',
            asset,
            price: 0,
            error: e.message,
            engine: 'python-error',
            calculated_at: new Date().toISOString(),
            reasons: [`Python error: ${e.message}`],
            analysis: {},
            zones: {},
        };
    }
}

module.exports = { getDailyTrade };
