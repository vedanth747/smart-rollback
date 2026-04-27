const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PORT = process.env.CONTROLLER_PORT || 5000;
const scriptPath = path.join(__dirname, 'deploy.bat');
const dashboardPath = path.join(__dirname, 'dashboard.html');
const MAX_LOG_LINES = 300;
const DEFAULT_VERSION = 'v3';
const ALLOWED_VERSIONS = new Set(['v1', 'v2', 'v3']);

const JENKINS_URL = (process.env.JENKINS_URL || 'http://localhost:8080').replace(/\/$/, '');
const JENKINS_JOB = process.env.JENKINS_JOB || 'rollback-pipeline';
const JENKINS_USER = process.env.JENKINS_USER || '';
const JENKINS_TOKEN = process.env.JENKINS_TOKEN || '';
const JENKINS_TRIGGER_TOKEN = process.env.JENKINS_TRIGGER_TOKEN || '';

const crumbCache = {
    headers: null,
    expiresAt: 0
};

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

function runGitCommand(args) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd: __dirname }, (error, stdout, stderr) => {
            if (error) {
                const message = (stderr || error.message || '').trim();
                resolve({ ok: false, error: message || 'Git command failed' });
                return;
            }

            resolve({ ok: true, output: stdout.trim() });
        });
    });
}

async function fetchGitStatus() {
    const [head, message, branch] = await Promise.all([
        runGitCommand(['rev-parse', '--short', 'HEAD']),
        runGitCommand(['log', '-1', '--pretty=%s']),
        runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'])
    ]);

    if (!head.ok || !message.ok) {
        return {
            ok: false,
            message: head.error || message.error || 'Git not available'
        };
    }

    return {
        ok: true,
        shortSha: head.output,
        message: message.output,
        branch: branch.ok ? branch.output : 'unknown'
    };
}

function getJenkinsAuthHeader() {
    if (!JENKINS_USER || !JENKINS_TOKEN) {
        return null;
    }

    const encoded = Buffer.from(`${JENKINS_USER}:${JENKINS_TOKEN}`).toString('base64');
    return `Basic ${encoded}`;
}

function getJenkinsJobPath() {
    return `/job/${encodeURIComponent(JENKINS_JOB)}`;
}

function requestJenkins(pathname, options = {}) {
    return new Promise((resolve, reject) => {
        const targetUrl = new URL(pathname, JENKINS_URL);
        const isSecure = targetUrl.protocol === 'https:';
        const requestFn = isSecure ? https.request : http.request;
        const req = requestFn({
            protocol: targetUrl.protocol,
            hostname: targetUrl.hostname,
            port: targetUrl.port || (isSecure ? 443 : 80),
            path: `${targetUrl.pathname}${targetUrl.search}`,
            method: options.method || 'GET',
            headers: options.headers || {}
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk.toString();
            });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers,
                    body: data
                });
            });
        });

        req.on('error', reject);

        if (options.body) {
            req.write(options.body);
        }

        req.end();
    });
}

async function requestJenkinsJson(pathname, options = {}) {
    const response = await requestJenkins(pathname, options);
    let data = null;
    try {
        data = response.body ? JSON.parse(response.body) : null;
    } catch (error) {
        data = null;
    }

    return { response, data };
}

async function getCrumbHeaders() {
    const authHeader = getJenkinsAuthHeader();
    if (!authHeader) {
        return {};
    }

    const now = Date.now();
    if (crumbCache.headers && crumbCache.expiresAt > now) {
        return crumbCache.headers;
    }

    const response = await requestJenkinsJson('/crumbIssuer/api/json', {
        headers: {
            Authorization: authHeader
        }
    });

    if (!response.data || response.response.statusCode >= 400) {
        return {};
    }

    const headerName = response.data.crumbRequestField;
    const headerValue = response.data.crumb;
    if (!headerName || !headerValue) {
        return {};
    }

    crumbCache.headers = { [headerName]: headerValue };
    crumbCache.expiresAt = now + 10 * 60 * 1000;
    return crumbCache.headers;
}

async function fetchBuildDetails(jobPath, buildNumber, headers) {
    const buildResponse = await requestJenkinsJson(`${jobPath}/${buildNumber}/api/json?tree=number,result,building,timestamp,displayName,url,changeSet[items[commitId,msg,author[fullName]]]`, {
        headers
    });

    if (!buildResponse.data || buildResponse.response.statusCode >= 400) {
        return null;
    }

    const changes = (buildResponse.data.changeSet && buildResponse.data.changeSet.items) || [];
    const commit = changes.length > 0 ? {
        id: changes[0].commitId,
        message: changes[0].msg,
        author: changes[0].author && changes[0].author.fullName
    } : null;

    return {
        number: buildResponse.data.number,
        result: buildResponse.data.result,
        building: buildResponse.data.building,
        timestamp: buildResponse.data.timestamp,
        displayName: buildResponse.data.displayName,
        url: buildResponse.data.url,
        commit
    };
}

async function fetchJenkinsStatus() {
    const authHeader = getJenkinsAuthHeader();
    const jobPath = getJenkinsJobPath();
    const headers = authHeader ? { Authorization: authHeader } : {};
    const jobResponse = await requestJenkinsJson(`${jobPath}/api/json?tree=fullName,color,lastBuild[number,url],lastSuccessfulBuild[number,url],lastFailedBuild[number,url]`, {
        headers
    });

    if (!jobResponse.data || jobResponse.response.statusCode >= 400) {
        return {
            ok: false,
            message: `Jenkins job not reachable (${jobResponse.response.statusCode || 'unknown'})`
        };
    }

    const payload = {
        ok: true,
        jenkinsUrl: JENKINS_URL,
        job: {
            name: jobResponse.data.fullName || JENKINS_JOB,
            url: `${JENKINS_URL}${jobPath}`
        },
        lastBuild: jobResponse.data.lastBuild || null,
        lastSuccessfulBuild: jobResponse.data.lastSuccessfulBuild || null,
        lastFailedBuild: jobResponse.data.lastFailedBuild || null
    };

    if (payload.lastBuild && payload.lastBuild.number) {
        const details = await fetchBuildDetails(jobPath, payload.lastBuild.number, headers);
        if (details) {
            payload.lastBuild = {
                ...payload.lastBuild,
                number: details.number,
                result: details.result,
                building: details.building,
                timestamp: details.timestamp,
                displayName: details.displayName,
                url: details.url
            };
            if (details.commit) {
                payload.lastCommit = details.commit;
            }
        }
    }

    if (payload.lastSuccessfulBuild && payload.lastSuccessfulBuild.number) {
        const successDetails = await fetchBuildDetails(jobPath, payload.lastSuccessfulBuild.number, headers);
        if (successDetails) {
            payload.lastSuccessfulBuild = {
                ...payload.lastSuccessfulBuild,
                number: successDetails.number,
                url: successDetails.url
            };
            if (successDetails.commit) {
                payload.lastSuccessfulCommit = successDetails.commit;
            }
        }
    }

    return payload;
}

async function triggerJenkinsBuild() {
    const authHeader = getJenkinsAuthHeader();
    const jobPath = getJenkinsJobPath();
    const tokenQuery = JENKINS_TRIGGER_TOKEN ? `?token=${encodeURIComponent(JENKINS_TRIGGER_TOKEN)}` : '';
    const headers = authHeader ? { Authorization: authHeader } : {};
    const crumbHeaders = await getCrumbHeaders();
    const response = await requestJenkins(`${jobPath}/build${tokenQuery}`, {
        method: 'POST',
        headers: {
            ...headers,
            ...crumbHeaders
        }
    });

    const ok = response.statusCode >= 200 && response.statusCode < 300;
    return {
        ok,
        statusCode: response.statusCode,
        queueUrl: response.headers.location || null
    };
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

const server = http.createServer(async (req, res) => {
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

    if (req.method === 'GET' && requestPath === '/git/status') {
        try {
            const payload = await fetchGitStatus();
            sendJson(res, 200, payload);
        } catch (error) {
            sendJson(res, 200, { ok: false, message: 'Unable to read git status' });
        }
        return;
    }

    if (req.method === 'GET' && requestPath === '/jenkins/status') {
        try {
            const payload = await fetchJenkinsStatus();
            sendJson(res, 200, payload);
        } catch (error) {
            sendJson(res, 200, { ok: false, message: 'Unable to reach Jenkins' });
        }
        return;
    }

    if (req.method === 'POST' && requestPath === '/jenkins/build') {
        try {
            const result = await triggerJenkinsBuild();
            const status = result.ok ? 202 : (result.statusCode === 401 ? 401 : 500);
            sendJson(res, status, {
                ok: result.ok,
                statusCode: result.statusCode,
                queueUrl: result.queueUrl
            });
        } catch (error) {
            sendJson(res, 500, { ok: false, message: 'Unable to trigger Jenkins build' });
        }
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