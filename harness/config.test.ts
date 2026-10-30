import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, collectFiles, resolveInference } from './config.js';
import { compile } from './compile.js';
import { parseTemplate } from '../src/templates/parse.js';
const example = () => JSON.parse(fs.readFileSync('harness/jobs.example.json', 'utf8'));

test('compiles real upstream templates with selected skills, schedules and MCP', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  try {
    compile(validateConfig(example()), path.resolve('harness'), path.join(tmp, 'templates'));
    const incident = parseTemplate(path.join(tmp, 'templates/incident'));
    assert.deepEqual(
      incident.skills.map((s) => s.name),
      ['incident-triage'],
    );
    assert.equal(incident.tasks.length, 0);
    const health = parseTemplate(path.join(tmp, 'templates/daily-health'));
    assert.equal(health.tasks[0].schedule, '0 8 * * 1-5');
    const ios = parseTemplate(path.join(tmp, 'templates/ios-check'));
    assert.equal('command' in ios.mcpServers.macos && ios.mcpServers.macos.command, 'node');
    assert.deepEqual(ios.report, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('rejects invalid routes and privilege/configuration mistakes', () => {
  for (const mutate of [
    (c: any) => (c.jobs[0].playbook = '../secrets'),
    (c: any) => (c.jobs[0].members = []),
    (c: any) => (c.jobs[0].triggers[0].kind = 'webhook'),
    (c: any) => (c.jobs[0].triggers = [{ kind: 'pattern', channel: 'C00000001', pattern: '[' }]),
    (c: any) => (c.jobs[1].sink = { kind: 'thread' }),
    (c: any) => (c.jobs[2].macos.url = 'https://secret@example.com/'),
    (c: any) => (c.jobs[2].macos.url = 'http://example.com/'),
    (c: any) => c.jobs.push({ ...c.jobs[0], id: 'duplicate-route' }),
  ]) {
    const config = example();
    mutate(config);
    assert.throws(() => validateConfig(config));
  }
});
test('refuses symlinks in skill assets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  try {
    fs.symlinkSync('/etc/passwd', path.join(tmp, 'asset'));
    assert.throws(() => collectFiles(tmp), /Symlink/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolves job inference overrides without selecting credentials or accepting invalid settings', () => {
  const input = example();
  input.inference = { model: 'test-default-model', effort: 'medium' };
  input.jobs[0].inference = { effort: 'high' };
  input.jobs[1].inference = { model: 'test-report-model', effort: 'low' };
  const config = validateConfig(input);
  assert.deepEqual(resolveInference(config, config.jobs[0]), { model: 'test-default-model', effort: 'high' });
  assert.deepEqual(resolveInference(config, config.jobs[1]), { model: 'test-report-model', effort: 'low' });
  assert.deepEqual(resolveInference(config, config.jobs[2]), { model: 'test-default-model', effort: 'medium' });
  const legacy = validateConfig(example());
  assert.deepEqual(resolveInference(legacy, legacy.jobs[0]), {});
  for (const inference of [
    null,
    [],
    { model: '' },
    { effort: 4 },
    { model: 'name\nother' },
    { account: 'other-seat' },
  ]) {
    assert.throws(() => validateConfig({ ...example(), inference }));
    const invalidJob = example();
    invalidJob.jobs[0].inference = inference;
    assert.throws(() => validateConfig(invalidJob));
  }
});
