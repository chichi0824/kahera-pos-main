import test from 'node:test';
import assert from 'node:assert/strict';
import { saveMenu, validateMenu } from '../src/index.js';

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
