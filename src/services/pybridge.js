const { execFile } = require('child_process');
const path = require('path');

const ENGINE = path.join(__dirname, '../../python/engine.py');

function runPython(args, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
        execFile('python3', [ENGINE, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr?.trim() || err.message));
            try {
                const data = JSON.parse(stdout);
                if (data.error) return reject(new Error(data.error));
                resolve(data);
            } catch (_) {
                reject(new Error('Invalid JSON from Python: ' + stdout.slice(0, 300)));
            }
        });
    });
}

async function pyAnalyst() { return runPython(['analyst'], 60000); }
async function pySignals() { return runPython(['signals'], 60000); }
async function pyDaytrader(asset) { return runPython(['daytrader', asset], 30000); }

module.exports = { pyAnalyst, pySignals, pyDaytrader };
