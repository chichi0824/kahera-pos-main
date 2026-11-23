import test from 'node:test';
import assert from 'node:assert/strict';
import { saveMenu, validateMenu, validateOnlineOrder } from '../src/index.js';

function menuPayload(item, category = { id: 'meals', name: 'Ulam' }) {
  return {
    settings: { bizName: "Victoria's", bizNote: 'Sta. Cruz, Laguna', vatRegistered: true },
    categories: [category],
    menu: [item]
  };
}

const eggRoll = {
  id: 'egg-roll', cat: 'meals', name: 'Egg Roll', price: 1500,
  halfPrice: null, available: true, soldOut: false,
  variants: [
    { id: 'egg-1', name: '1 Piece', price: 1500, available: true, soldOut: false },
    { id: 'egg-5', name: '5 Pieces', price: 7000, available: true, soldOut: false },
    { id: 'egg-10', name: '10 Pieces', price: 13000, available: true, soldOut: false }
  ]
};

test('allows Ulam items to use named price options', () => {
  assert.doesNotThrow(() => validateMenu(menuPayload(eggRoll)));
});

test('keeps regular non-option items with full and half prices valid', () => {
  assert.doesNotThrow(() => validateMenu(menuPayload({
    id: 'fried-egg', cat: 'meals', name: 'Fried Egg', price: 1800,
    halfPrice: 900, available: true, soldOut: false, variants: []
  })));
});

test('still requires Drinks items to have at least one price option', () => {
  assert.throws(() => validateMenu(menuPayload({
    id: 'water', cat: 'drinks', name: 'Water', price: 1000,
    halfPrice: null, available: true, soldOut: false, variants: []
  }, { id: 'drinks', name: 'Drinks' })), /Drinks must have at least one price option/);
});

test('rejects price-option items with a half-order price', () => {
  assert.throws(() => validateMenu(menuPayload({ ...eggRoll, halfPrice: 700 })), /cannot have a half-order price/);
});

test('rejects duplicate option names regardless of letter case', () => {
  assert.throws(() => validateMenu(menuPayload({
    ...eggRoll,
    variants: [
      { id: 'one', name: '5 Pieces', price: 1500 },
      { id: 'two', name: '5 pieces', price: 7000 }
    ]
  })), /menu price option is invalid/i);
});

test('validates the complete menu before making one D1 batch write', async () => {
  let batchCalls = 0, batchedStatements = [];
  const db = {
    prepare(sql) { return { sql, values: [], bind(...values) { this.values = values; return this; } }; },
    async batch(statements) { batchCalls += 1; batchedStatements = statements; }
  };
  await saveMenu(db, menuPayload(eggRoll));
  assert.equal(batchCalls, 1);
  assert.ok(batchedStatements.some(s => s.sql.includes('INSERT INTO menu_items')));
  assert.ok(batchedStatements.some(s => s.sql.includes('INSERT INTO menu_categories')));
});

test('does not write to D1 when menu validation fails', async () => {
  let batchCalls = 0;
  const db = {
    prepare(sql) { return { sql, bind() { return this; } }; },
    async batch() { batchCalls += 1; }
  };
  await assert.rejects(() => saveMenu(db, menuPayload({ ...eggRoll, price: 1200 })), /first option as the base price/);
  assert.equal(batchCalls, 0);
});


import worker from '../src/index.js';

function authDb() {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() { return null; },
        async run() { return { success: true }; },
        async all() { return { results: [] }; }
      };
    }
  };
}
function authRequest(path, method='GET', body, token) {
  const headers = { Origin: 'https://chichi0824.github.io' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  return new Request('https://kahera-menu-api.example.workers.dev' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
}
const authEnv = () => ({
  kahera_db: authDb(),
  ADMIN_PASSWORD: 'test-owner-password',
  SESSION_SECRET: 'test-session-secret-with-sufficient-entropy',
  APP_ORIGINS: 'https://chichi0824.github.io'
});

test('owner login issues a session token and session endpoint accepts it', async () => {
  const env = authEnv();
  const login = await worker.fetch(authRequest('/api/auth/login', 'POST', { password: 'test-owner-password' }), env);
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.ok(token);
  const session = await worker.fetch(authRequest('/api/auth/session', 'GET', undefined, token), env);
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: true });
});

test('owner login rejects an incorrect password', async () => {
  const response = await worker.fetch(authRequest('/api/auth/login', 'POST', { password: 'wrong-password' }), authEnv());
  assert.equal(response.status, 401);
});

test('administrative API routes reject requests without an owner session', async () => {
  const response = await worker.fetch(authRequest('/api/reports?from=2026-11-23&to=2026-11-23'), authEnv());
  assert.equal(response.status, 401);
});

test('administrative API routes accept a valid owner session', async () => {
  const env = authEnv();
  const login = await worker.fetch(authRequest('/api/auth/login', 'POST', { password: 'test-owner-password' }), env);
  const { token } = await login.json();
  const response = await worker.fetch(authRequest('/api/reports?from=2026-11-23&to=2026-11-23', 'GET', undefined, token), env);
  assert.equal(response.status, 200);
});



test('accepts a pickup order with customer contact details', () => {
  const result = validateOnlineOrder({
    id: 'customer-order-123456',
    customerName: 'Juan Dela Cruz',
    customerPhone: '09171234567',
    fulfillmentType: 'pickup',
    lines: [{ id: 'ulam-1', qty: 2 }]
  });
  assert.deepEqual(result, { address: '', contactRequested: false });
});

test('requires a delivery address or contact request for delivery orders', () => {
  assert.throws(() => validateOnlineOrder({
    id: 'customer-order-123456',
    customerName: 'Juan Dela Cruz',
    customerPhone: '09171234567',
    fulfillmentType: 'delivery',
    lines: [{ id: 'ulam-1', qty: 1 }]
  }), /Enter your delivery address or ask the store to contact you/);
});

test('allows delivery when the customer asks staff to confirm the address', () => {
  const result = validateOnlineOrder({
    id: 'customer-order-123456',
    customerName: 'Juan Dela Cruz',
    customerPhone: '09171234567',
    fulfillmentType: 'delivery',
    deliveryContactRequested: true,
    lines: [{ id: 'ulam-1', qty: 1 }]
  });
  assert.deepEqual(result, { address: '', contactRequested: true });
});

test('rejects delivery details on a pickup order', () => {
  assert.throws(() => validateOnlineOrder({
    id: 'customer-order-123456',
    customerName: 'Juan Dela Cruz',
    customerPhone: '09171234567',
    fulfillmentType: 'pickup',
    deliveryAddress: '123 Main Street',
    lines: [{ id: 'ulam-1', qty: 1 }]
  }), /Pickup orders do not need delivery details/);
});

test('requires customer name and contact number for online orders', () => {
  assert.throws(() => validateOnlineOrder({
    id: 'customer-order-123456',
    customerName: '',
    customerPhone: '',
    fulfillmentType: 'pickup',
    lines: [{ id: 'ulam-1', qty: 1 }]
  }), /Please complete your name, contact number/);
});
