'use strict';

/**
 * Legacy-style monolith: orders + inventory in one process.
 * Intentionally simple / slightly "enterprise-era" — in-memory, one binary.
 * Not a real POS. Educational strangler-fig lab only.
 */

const http = require('http');
const { randomUUID } = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

/** @type {Map<string, object>} */
const orders = new Map();

/** @type {Map<string, { sku: string, name: string, quantity: number }>} */
const inventory = new Map([
  ['SKU-COFFEE-01', { sku: 'SKU-COFFEE-01', name: 'House Blend Beans 1kg', quantity: 100 }],
  ['SKU-MUG-12', { sku: 'SKU-MUG-12', name: 'Ceramic Mug 12oz', quantity: 40 }],
  ['SKU-FILTER-100', { sku: 'SKU-FILTER-100', name: 'Paper Filters (100pk)', quantity: 200 }],
]);

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Served-By': 'legacy-monolith',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function validateOrderCreate(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.customerId || typeof body.customerId !== 'string') return 'customerId (string) required';
  if (!Array.isArray(body.items) || body.items.length === 0) return 'items (non-empty array) required';
  for (const item of body.items) {
    if (!item || typeof item.sku !== 'string' || !item.sku) return 'each item needs sku';
    if (!Number.isInteger(item.quantity) || item.quantity < 1) return 'each item needs quantity >= 1';
  }
  return null;
}

function createOrder(body) {
  for (const item of body.items) {
    const stock = inventory.get(item.sku);
    if (!stock) {
      const err = new Error(`unknown sku: ${item.sku}`);
      err.status = 404;
      throw err;
    }
    if (stock.quantity < item.quantity) {
      const err = new Error(
        `insufficient stock for ${item.sku}: have ${stock.quantity}, need ${item.quantity}`,
      );
      err.status = 409;
      throw err;
    }
  }
  for (const item of body.items) {
    const stock = inventory.get(item.sku);
    stock.quantity -= item.quantity;
  }

  const id = randomUUID();
  const order = {
    id,
    customerId: body.customerId,
    items: body.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    status: 'confirmed',
    createdAt: new Date().toISOString(),
  };
  orders.set(id, order);
  return order;
}

function getOrder(id) {
  return orders.get(id) || null;
}

function getInventory(sku) {
  return inventory.get(sku) || null;
}

function reserveInventory(sku, quantity) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    const err = new Error('quantity (integer >= 1) required');
    err.status = 400;
    throw err;
  }
  const stock = inventory.get(sku);
  if (!stock) {
    const err = new Error(`unknown sku: ${sku}`);
    err.status = 404;
    throw err;
  }
  if (stock.quantity < quantity) {
    const err = new Error(
      `insufficient stock for ${sku}: have ${stock.quantity}, need ${quantity}`,
    );
    err.status = 409;
    throw err;
  }
  stock.quantity -= quantity;
  return {
    sku: stock.sku,
    reserved: quantity,
    remaining: stock.quantity,
  };
}

async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method || 'GET').toUpperCase();

  try {
    if (method === 'GET' && path === '/health') {
      return send(res, 200, { status: 'ok', service: 'legacy-monolith' });
    }

    if (method === 'POST' && path === '/orders') {
      const body = await readBody(req);
      const verr = validateOrderCreate(body);
      if (verr) return send(res, 400, { error: verr });
      const order = createOrder(body);
      return send(res, 201, order);
    }

    const orderMatch = path.match(/^\/orders\/([^/]+)$/);
    if (method === 'GET' && orderMatch) {
      const order = getOrder(orderMatch[1]);
      if (!order) return send(res, 404, { error: 'order not found' });
      return send(res, 200, order);
    }

    const invMatch = path.match(/^\/inventory\/([^/]+)$/);
    if (method === 'GET' && invMatch) {
      const item = getInventory(decodeURIComponent(invMatch[1]));
      if (!item) return send(res, 404, { error: 'sku not found' });
      return send(res, 200, item);
    }

    const reserveMatch = path.match(/^\/inventory\/([^/]+)\/reserve$/);
    if (method === 'POST' && reserveMatch) {
      const body = await readBody(req);
      const result = reserveInventory(decodeURIComponent(reserveMatch[1]), body.quantity);
      return send(res, 200, result);
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err.status || 500;
    return send(res, status, { error: err.message || 'internal error' });
  }
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`legacy-monolith listening on http://${HOST}:${PORT}`);
  });
}

module.exports = {
  server,
  createOrder,
  getOrder,
  getInventory,
  reserveInventory,
  validateOrderCreate,
  orders,
  inventory,
};
