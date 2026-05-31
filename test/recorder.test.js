import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flushPending } from '../src/recording/recorder.js';

test('flushPending ne se fige pas si une capture ne se termine jamais', async () => {
  // Une promesse qui ne se résout jamais (capture coincée).
  const session = { pending: new Set([new Promise(() => {})]) };
  const t0 = Date.now();
  await flushPending(session, 60);
  assert.ok(Date.now() - t0 >= 55, 'a attendu le garde-fou puis a continué');
});

test('flushPending revient vite quand toutes les captures sont déjà terminées', async () => {
  const session = { pending: new Set([Promise.resolve(), Promise.resolve()]) };
  const t0 = Date.now();
  await flushPending(session, 5000);
  assert.ok(Date.now() - t0 < 1000, 'résolu sans attendre le garde-fou');
});
