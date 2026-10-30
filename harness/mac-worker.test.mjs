import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createWorker, executeRecipe } from './mac-worker.mjs';
const token = 'test-only-token-that-is-at-least-32-characters';
const config = {
  recipes: { check: { cwd: '/tmp', argv: [process.execPath, '-e', 'console.log("ok")'], timeoutMs: 1000 } },
};

test('worker authenticates, rejects arbitrary commands, and serializes runs', async () => {
  let release;
  let calls = 0;
  const server = createWorker(config, token, async () => {
    calls++;
    await new Promise((resolve) => {
      release = resolve;
    });
    return { exitCode: 0, output: 'ok' };
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/run`;
  const post = (body, auth = token) =>
    fetch(url, { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ recipe: 'check' }, 'bad')).status, 401);
    assert.equal((await post({ recipe: 'check', command: 'rm -rf /' })).status, 400);
    assert.equal((await post({ recipe: 'toString' })).status, 400);
    const first = post({ recipe: 'check' });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await post({ recipe: 'check' })).status, 409);
    release();
    assert.equal((await (await first).json()).output, 'ok');
    assert.equal(calls, 1);
  } finally {
    release?.();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('recipe runner captures real output and terminates overdue jobs', async () => {
  assert.equal((await executeRecipe(config.recipes.check)).output.trim(), 'ok');
  const result = await executeRecipe({
    cwd: '/tmp',
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
    timeoutMs: 100,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});
