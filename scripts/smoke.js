'use strict';

/**
 * End-to-end smoke through the gateway:
 *   create order → get order → check inventory
 * Default routing: orders → orders-go, inventory → legacy.
 *
 * Usage:
 *   node scripts/smoke.js              # assumes stack already up
 *   node scripts/smoke.js --start      # start stack, smoke, stop
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '..');
const GATEWAY = process.env.GATEWAY_URL || 'http://127.0.0.1:8000';
const START = process.argv.includes('--start');

const children = [];

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

function request(url, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = { _raw: raw };
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json,
            servedBy: res.headers['x-served-by'],
            target: res.headers['x-gateway-target'],
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function waitUrl(url, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await request(url, 'GET');
      if (res.status === 200) return res;
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error(`not healthy: ${url}`);
}

function spawnProc(cmd, args, env, cwd) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  child.stdout.on('data', (d) => process.stdout.write(`[${path.basename(cwd)}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${path.basename(cwd)}] ${d}`));
  return child;
}

async function buildGo(dir, out) {
  await new Promise((resolve, reject) => {
    const b = spawn('go', ['build', '-o', out, '.'], {
      cwd: dir,
      stdio: 'inherit',
      windowsHide: true,
    });
    b.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`go build failed in ${dir}`))));
  });
}

async function startStack() {
  log('building Go binaries...');
  const ordersDir = path.join(ROOT, 'services', 'orders-go');
  const gwDir = path.join(ROOT, 'gateway');
  const ordersBin = process.platform === 'win32' ? 'orders-go-bin.exe' : 'orders-go-bin';
  const gwBin = process.platform === 'win32' ? 'gateway-bin.exe' : 'gateway-bin';

  await buildGo(ordersDir, ordersBin);
  await buildGo(gwDir, gwBin);

  log('starting legacy on :8080');
  spawnProc(
    process.execPath,
    [path.join(ROOT, 'legacy', 'server.js')],
    { PORT: '8080', HOST: '127.0.0.1' },
    path.join(ROOT, 'legacy'),
  );

  log('starting orders-go on :8081 (inventory → legacy)');
  spawnProc(
    path.join(ordersDir, ordersBin),
    [],
    { PORT: '8081', INVENTORY_URL: 'http://127.0.0.1:8080' },
    ordersDir,
  );

  log('starting gateway on :8000 (orders→go, inventory→legacy)');
  spawnProc(
    path.join(gwDir, gwBin),
    [],
    {
      PORT: '8000',
      LEGACY_URL: 'http://127.0.0.1:8080',
      ORDERS_URL: 'http://127.0.0.1:8081',
      INVENTORY_URL: 'http://127.0.0.1:8082',
      ROUTE_ORDERS_NEW: 'true',
      ROUTE_INVENTORY_NEW: 'false',
    },
    gwDir,
  );

  await waitUrl('http://127.0.0.1:8080/health');
  await waitUrl('http://127.0.0.1:8081/health');
  await waitUrl('http://127.0.0.1:8000/health');
  log('stack ready');
}

function stopStack() {
  for (const c of children) {
    try {
      if (process.platform === 'win32' && c.pid) {
        spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        c.kill('SIGTERM');
      }
    } catch {
      // ignore
    }
  }
}

async function runSmoke() {
  const base = GATEWAY.replace(/\/$/, '');

  log('GET /health');
  const health = await request(`${base}/health`, 'GET');
  if (health.status !== 200) throw new Error(`health failed: ${health.status}`);
  log(`  routing: ${JSON.stringify(health.body.routing || health.body)}`);

  log('GET /inventory/SKU-COFFEE-01 (expect legacy)');
  const invBefore = await request(`${base}/inventory/SKU-COFFEE-01`, 'GET');
  if (invBefore.status !== 200) throw new Error(`inventory get failed: ${JSON.stringify(invBefore.body)}`);
  log(`  qty=${invBefore.body.quantity} served-by=${invBefore.servedBy} target=${invBefore.target}`);
  if (invBefore.servedBy && invBefore.servedBy !== 'legacy-monolith') {
    log(`  note: inventory served by ${invBefore.servedBy} (demo default is legacy)`);
  }

  log('POST /orders (expect orders-go, reserves via legacy inventory)');
  const create = await request(`${base}/orders`, 'POST', {
    customerId: 'smoke-customer',
    items: [{ sku: 'SKU-COFFEE-01', quantity: 2 }],
  });
  if (create.status !== 201) {
    throw new Error(`create order failed: ${create.status} ${JSON.stringify(create.body)}`);
  }
  log(`  id=${create.body.id} served-by=${create.servedBy} target=${create.target}`);
  if (!create.body.id || create.body.status !== 'confirmed') {
    throw new Error('order shape invalid');
  }
  if (create.servedBy && create.servedBy !== 'orders-go') {
    throw new Error(`expected orders-go, got ${create.servedBy}`);
  }

  log(`GET /orders/${create.body.id}`);
  const got = await request(`${base}/orders/${create.body.id}`, 'GET');
  if (got.status !== 200 || got.body.id !== create.body.id) {
    throw new Error(`get order failed: ${JSON.stringify(got.body)}`);
  }
  log(`  ok status=${got.body.status}`);

  log('GET /inventory/SKU-COFFEE-01 after reserve');
  const invAfter = await request(`${base}/inventory/SKU-COFFEE-01`, 'GET');
  if (invAfter.status !== 200) throw new Error('inventory after failed');
  const expected = invBefore.body.quantity - 2;
  if (invAfter.body.quantity !== expected) {
    throw new Error(`expected qty ${expected}, got ${invAfter.body.quantity}`);
  }
  log(`  qty=${invAfter.body.quantity} (decreased by 2)`);

  log('SMOKE PASS');
}

(async () => {
  try {
    if (START) {
      await startStack();
    } else {
      await waitUrl(`${GATEWAY.replace(/\/$/, '')}/health`, 10).catch(() => {
        throw new Error(
          'gateway not reachable. Start the stack (make up / scripts/dev-up) or re-run with --start',
        );
      });
    }
    await runSmoke();
    if (START) stopStack();
    process.exit(0);
  } catch (err) {
    console.error(`[smoke] FAIL: ${err.message}`);
    if (START) stopStack();
    process.exit(1);
  }
})();
