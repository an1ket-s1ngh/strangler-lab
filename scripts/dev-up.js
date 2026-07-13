'use strict';

/**
 * Start the partial-strangler demo stack in the foreground.
 * Ctrl+C stops all children.
 *
 *   node scripts/dev-up.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '..');
const children = [];

function spawnProc(label, cmd, args, env, cwd) {
  console.log(`[dev-up] start ${label}`);
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  const prefix = (d) =>
    d
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => console.log(`[${label}] ${line}`));
  child.stdout.on('data', prefix);
  child.stderr.on('data', prefix);
  child.on('exit', (code, signal) => {
    console.log(`[dev-up] ${label} exited code=${code} signal=${signal}`);
  });
  return child;
}

function buildGo(dir, out) {
  return new Promise((resolve, reject) => {
    const b = spawn('go', ['build', '-o', out, '.'], {
      cwd: dir,
      stdio: 'inherit',
      windowsHide: true,
    });
    b.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build failed: ${dir}`))));
  });
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitPort(port, name) {
  for (let i = 0; i < 50; i++) {
    if (await health(port)) {
      console.log(`[dev-up] ${name} healthy on :${port}`);
      return;
    }
    await sleep(200);
  }
  throw new Error(`${name} failed to start on :${port}`);
}

function shutdown() {
  console.log('\n[dev-up] shutting down...');
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
  setTimeout(() => process.exit(0), 300).unref();
}

(async () => {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const ordersDir = path.join(ROOT, 'services', 'orders-go');
  const invDir = path.join(ROOT, 'services', 'inventory-go');
  const gwDir = path.join(ROOT, 'gateway');
  const ext = process.platform === 'win32' ? '.exe' : '';

  console.log('[dev-up] building Go services...');
  await buildGo(ordersDir, `orders-go-bin${ext}`);
  await buildGo(invDir, `inventory-go-bin${ext}`);
  await buildGo(gwDir, `gateway-bin${ext}`);

  spawnProc(
    'legacy',
    process.execPath,
    [path.join(ROOT, 'legacy', 'server.js')],
    { PORT: '8080', HOST: '127.0.0.1' },
    path.join(ROOT, 'legacy'),
  );
  spawnProc(
    'orders-go',
    path.join(ordersDir, `orders-go-bin${ext}`),
    [],
    { PORT: '8081', INVENTORY_URL: 'http://127.0.0.1:8080' },
    ordersDir,
  );
  // inventory-go is built and ready for full cutover demos, not routed by default.
  spawnProc(
    'inventory-go',
    path.join(invDir, `inventory-go-bin${ext}`),
    [],
    { PORT: '8082' },
    invDir,
  );
  spawnProc(
    'gateway',
    path.join(gwDir, `gateway-bin${ext}`),
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

  await waitPort(8080, 'legacy');
  await waitPort(8081, 'orders-go');
  await waitPort(8082, 'inventory-go');
  await waitPort(8000, 'gateway');

  console.log(`
[dev-up] stack up (partial strangler)
  gateway     http://127.0.0.1:8000   ← clients enter here
  legacy      http://127.0.0.1:8080   inventory still here
  orders-go   http://127.0.0.1:8081   orders cut over
  inventory-go http://127.0.0.1:8082  ready; not routed yet

  curl http://127.0.0.1:8000/__routes
  node scripts/smoke.js
  Ctrl+C to stop
`);
})().catch((err) => {
  console.error('[dev-up]', err.message);
  shutdown();
  process.exit(1);
});
