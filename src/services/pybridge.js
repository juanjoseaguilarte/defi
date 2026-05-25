const { execFile } = require('child_process');
const path = require('path');

const ENGINE = path.join(__dirname, '../../python/engine.py');

function runPython(args, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
        execFile('python3', [ENGINE, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
            if (err) {
                const msg = stderr?.trim() || err.message;
                if (msg.includes('ModuleNotFoundError')) {
                    return reject(new Error('Python: falta instalar dependencias. Ejecuta: pip3 install pandas numpy requests'));
                }
                if (err.killed) {
                    return reject(new Error(`Python timeout (${timeoutMs/1000}s). Red lenta o Binance no responde.`));
                }
                return reject(new Error('Python: ' + msg.slice(0, 500)));
            }
            try {
                const data = JSON.parse(stdout);
                if (data.error) return reject(new Error(data.error));
                resolve(data);
            } catch (_) {
                reject(new Error('Python devolvió respuesta inválida: ' + stdout.slice(0, 200)));
            }
        });
    });
}

async function pyAnalyst() { return runPython(['analyst'], 60000); }
async function pySignals() { return runPython(['signals'], 60000); }
async function pyDaytrader(asset) { return runPython(['daytrader', asset], 30000); }

module.exports = { pyAnalyst, pySignals, pyDaytrader };
