const { pyDaytrader } = require('./pybridge');

async function getDailyTrade(asset) {
    return pyDaytrader(asset);
}

module.exports = { getDailyTrade };
