const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.CONTROLLER_PORT || 5000;
const scriptPath = path.join(__dirname, 'deploy.bat');
const dashboardPath = path.join(__dirname, 'dashboard.html');
const MAX_LOG_LINES = 300;
const DEFAULT_VERSION = 'v3';
const ALLOWED_VERSIONS = new Set(['v1', 'v2', 'v3']);

let dashboardHtml = '<h1>Dashboard unavailable</h1>';

try {
    dashboardHtml = fs.readFileSync(dashboardPath, 'utf8');
} catch (error) {
    console.error('Failed to read dashboard.html', error);
}

const deployState = {
    running: false,
    lastResult: 'idle',
    lastExitCode: null,
    startedAt: null,
    finishedAt: null,
    targetVersion: null,
    lastMessage: null,
    logs: []
};

function addLog(message) {
    const trimmed = message.toString().trim();
    if (!trimmed) {
        return;
    }

    if (trimmed.startsWith('RESULT:')) {
        deployState.lastMessage = trimmed.replace('RESULT:', '').trim();
    }

    const timestamp = new Date().toISOString();
    deployState.logs.push(`[${timestamp}] ${trimmed}`);

    if (deployState.logs.length > MAX_LOG_LINES) {
        deployState.logs.splice(0, deployState.logs.length - MAX_LOG_LINES);
    }
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function normalizeVersion(value) {
    if (!value) {
        return DEFAULT_VERSION;
    }

    const normalized = value.toLowerCase();
    return ALLOWED_VERSIONS.has(normalized) ? normalized : null;
}

function runDeployment(targetVersion) {
    if (deployState.running) {
        return false;
    }

    deployState.running = true;
    deployState.lastResult = 'running';
    deployState.lastExitCode = null;
    deployState.startedAt = new Date().toISOString();
    deployState.finishedAt = null;
    deployState.targetVersion = targetVersion;
    deployState.lastMessage = null;
    deployState.logs = [];
    addLog('Deployment started');
    addLog(`Target version: ${targetVersion}`);

    const isWindows = process.platform === 'win32';
    const command = isWindows ? 'cmd.exe' : 'sh';
    const args = isWindows ? ['/c', scriptPath, targetVersion] : [scriptPath, targetVersion];

    const child = spawn(command, args, {
        cwd: __dirname,
        windowsHide: true
    });

    child.stdout.on('data', (chunk) => {
        chunk
            .toString()
            .split(/\r?\n/)
            .filter(Boolean)
            .forEach(addLog);
    });

    child.stderr.on('data', (chunk) => {
        chunk
            .toString()
            .split(/\r?\n/)
            .filter(Boolean)
            .forEach((line) => addLog(`ERROR: ${line}`));
    });

    child.on('close', (code) => {
        deployState.running = false;
        deployState.lastExitCode = code;
        deployState.finishedAt = new Date().toISOString();
        deployState.lastResult = code === 0 ? 'success' : 'failed';
        addLog(`Deployment finished with code ${code}`);
    });

    return true;
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, 'http://localhost');
    const requestPath = url.pathname;

    if (req.method === 'GET' && requestPath === '/') {
        res.writeHead(200, {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-store'
        });
        res.end(dashboardHtml);
        return;
    }

    if (req.method === 'POST' && requestPath === '/deploy') {
        const targetVersion = normalizeVersion(url.searchParams.get('version'));
        if (!targetVersion) {
            sendJson(res, 400, { ok: false, message: 'Invalid version. Use v1, v2, or v3.' });
            return;
        }

        const started = runDeployment(targetVersion);
        if (!started) {
            sendJson(res, 409, { ok: false, message: 'Deployment already running.' });
            return;
        }

        sendJson(res, 202, { ok: true, message: `Deployment started for ${targetVersion}.` });
        return;
    }

    if (req.method === 'GET' && requestPath === '/deploy/status') {
        sendJson(res, 200, {
            running: deployState.running,
            lastResult: deployState.lastResult,
            lastExitCode: deployState.lastExitCode,
            startedAt: deployState.startedAt,
            finishedAt: deployState.finishedAt,
            targetVersion: deployState.targetVersion,
            lastMessage: deployState.lastMessage
        });
        return;
    }

    if (req.method === 'GET' && requestPath === '/deploy/logs') {
        const limit = Number.parseInt(url.searchParams.get('limit') || '', 10);
        const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, MAX_LOG_LINES)) : MAX_LOG_LINES;
        sendJson(res, 200, {
            running: deployState.running,
            lines: deployState.logs.slice(-safeLimit)
        });
        return;
    }

    sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
    console.log(`Controller running on port ${PORT}`);
});