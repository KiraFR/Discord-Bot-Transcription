import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flushPending } from '../src/recording/recorder.js';

test('flushPending does not hang if a capture never finishes', async () => {
  // A promise that never resolves (stuck capture).
  const session = { pending: new Set([new Promise(() => {})]) };
  const t0 = Date.now();
  await flushPending(session, 60);
  assert.ok(Date.now() - t0 >= 55, 'waited for the safety net then continued');
});

test('flushPending returns quickly when all captures are already done', async () => {
  const session = { pending: new Set([Promise.resolve(), Promise.resolve()]) };
  const t0 = Date.now();
  await flushPending(session, 5000);
  assert.ok(Date.now() - t0 < 1000, 'resolved without waiting for the safety net');
});
