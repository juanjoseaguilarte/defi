const { exec } = require('child_process');
const path = require('path');

const ENGINE = path.join(__dirname, '../../python/engine.py');

function runPython(args, timeoutMs = 45000) {
    const cmd = `python3 "${ENGINE}" ${args.join(' ')} 2>&1`;
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: timeoutMs }, (err, stdout) => {
            const output = (stdout || '').trim();
            if (err) {
                if (output.includes('ModuleNotFoundError') || output.includes('No module named')) {
                    return reject(new Error('Falta instalar: pip3 install pandas numpy requests. Detalle: ' + output.slice(0, 300)));
                }
                if (err.killed) {
                    return reject(new Error(`Timeout (${timeoutMs/1000}s). Binance no responde.`));
                }
                return reject(new Error(output || err.message));
            }
            try {
                const data = JSON.parse(output);
                if (data.error) return reject(new Error(data.error));
                resolve(data);
            } catch (_) {
                reject(new Error('Python JSON inválido: ' + output.slice(0, 300)));
            }
        });
    });
}

async function pyAnalyst() { return runPython(['analyst'], 60000); }
async function pySignals() { return runPython(['signals'], 60000); }
async function pyDaytrader(asset) { return runPython(['daytrader', asset], 30000); }

async function pyHealthCheck() {
    return new Promise((resolve) => {
        exec('python3 -c "import pandas, numpy, requests; print(\'ok\')" 2>&1', { timeout: 10000 }, (err, stdout) => {
            const out = (stdout || '').trim();
            if (err || out !== 'ok') {
                resolve({ ok: false, error: out || err?.message, fix: 'pip3 install pandas numpy requests' });
            } else {
                resolve({ ok: true });
            }
        });
    });
}

module.exports = { pyAnalyst, pySignals, pyDaytrader, pyHealthCheck };
