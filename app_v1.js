const http = require('http');

const PORT = process.env.PORT || 3000;
const VERSION = 'v1';

function applyCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

const server = http.createServer((req, res) => {
    applyCors(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const requestPath = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && requestPath === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>App ${VERSION} running</h1><p>Health endpoint: /status</p>`);
        return;
    }

    if (req.method === 'GET' && (requestPath === '/status' || requestPath === '/health')) {
        sendJson(res, 200, {
            version: VERSION,
            status: 'healthy',
            time: new Date().toISOString()
        });
        return;
    }

    sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
    console.log(`App ${VERSION} listening on port ${PORT}`);
});