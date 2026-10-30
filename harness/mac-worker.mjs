import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function validateWorker(config) {
  if (!config || !config.recipes || Object.keys(config.recipes).length === 0) throw new Error('recipes required');
  for (const [name, r] of Object.entries(config.recipes)) {
    if (
      !/^[a-z][a-z0-9-]{0,47}$/.test(name) ||
      !path.isAbsolute(r.cwd ?? '') ||
      !Array.isArray(r.argv) ||
      !r.argv.length ||
      !path.isAbsolute(r.argv[0]) ||
      !r.argv.every((v) => typeof v === 'string') ||
      !Number.isInteger(r.timeoutMs) ||
      r.timeoutMs < 100 ||
      r.timeoutMs > 1_800_000
    ) {
      throw new Error(`Invalid recipe: ${name}`);
    }
  }
  return config;
}

export function executeRecipe(recipe) {
  return new Promise((resolve, reject) => {
    const child = spawn(recipe.argv[0], recipe.argv.slice(1), {
      cwd: recipe.cwd,
      shell: false,
      detached: true,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', HOME: process.env.HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    const stop = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (err) {
        if (err.code !== 'ESRCH') reject(err);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, recipe.timeoutMs);
    const capture = (buffer) => {
      bytes += buffer.length;
      if (bytes <= 1_048_576) text += buffer.toString('utf8');
      else {
        truncated = true;
        stop();
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, truncated, output: text });
    });
  });
}

export function createWorker(config, token, execute = executeRecipe) {
  validateWorker(config);
  if (typeof token !== 'string' || token.length < 32) throw new Error('Worker token must be at least 32 characters');
  let busy = false;
  const expected = Buffer.from(`Bearer ${token}`);
  return http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      send(401, { error: 'Unauthorized' });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/run') {
      send(404, { error: 'Not found' });
      return;
    }
    if (busy) {
      send(409, { error: 'Worker busy; retry explicitly later' });
      return;
    }
    busy = true;
    try {
      let body = '';
      for await (const part of req) {
        body += part;
        if (Buffer.byteLength(body) > 4096) {
          send(413, { error: 'Request too large' });
          return;
        }
      }
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        send(400, { error: 'Invalid JSON' });
        return;
      }
      if (
        !input ||
        Object.keys(input).some((k) => k !== 'recipe') ||
        typeof input.recipe !== 'string' ||
        !Object.hasOwn(config.recipes, input.recipe)
      ) {
        send(400, { error: 'Expected one configured recipe name' });
        return;
      }
      const result = await execute(config.recipes[input.recipe]);
      send(200, { recipe: input.recipe, ...result });
    } catch {
      send(500, { error: 'Recipe failed to start; check worker configuration' });
    } finally {
      busy = false;
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') throw new Error('This worker must run natively inside macOS');
  const config = JSON.parse(fs.readFileSync(process.argv[2] ?? 'harness/mac-worker.local.json', 'utf8'));
  const token = fs.readFileSync(process.env.MAC_WORKER_TOKEN_FILE, 'utf8').trim();
  const server = createWorker(config, token);
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(Number(process.env.MAC_WORKER_PORT ?? 8787), '127.0.0.1', () =>
    console.log('macOS worker listening on 127.0.0.1'),
  );
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
