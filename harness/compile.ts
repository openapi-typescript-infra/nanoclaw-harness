import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFiles, type Config } from './config.js';
import { loadConfig } from './load-config.js';
import { parseTemplate } from '../src/templates/parse.js';

export function compile(config: Config, root: string, output: string) {
  const files = new Map<string, Buffer | string>();
  for (const job of config.jobs) {
    const put = (name: string, content: string | Buffer) => files.set(`${job.id}/${name}`, content);
    const playbookPath = path.join(root, 'playbooks', job.playbook);
    if (fs.lstatSync(playbookPath).isSymbolicLink()) throw new Error('Playbook symlink refused');
    const playbook = fs.readFileSync(playbookPath, 'utf8');
    const sink =
      job.sink.kind === 'thread'
        ? 'Reply in the originating Slack thread.'
        : 'Send the completed report to the destination named reports.';
    put(
      'plugin.json',
      JSON.stringify(
        {
          $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
          name: `harness-${job.id}`,
          version: '1.0.0',
          extensions: { 'ai.nanoco.nanoclaw': { agentName: `${config.company?.agentName ?? 'Harness'} ${job.id}` } },
        },
        null,
        2,
      ),
    );
    put(
      'ai.nanoco.nanoclaw/context/instructions.md',
      `${playbook}\n\n${sink}\n\nExecution identity: ${config.executionIdentity}. Slack membership grants access to this job; it does not grant ownership of the model account.\n${config.company ? `\nCompany: ${config.company.name}\nAgent: ${config.company.agentName}\n\nCompany context supplied by the operator:\n${config.company.context}\n` : ''}`,
    );
    for (const skill of job.skills) {
      for (const [file, content] of collectFiles(path.join(root, 'skills', skill)))
        put(`skills/${skill}/${file}`, content);
    }
    let schedule = 0;
    for (const trigger of job.triggers)
      if (trigger.kind === 'schedule') {
        put(
          `ai.nanoco.nanoclaw/tasks/${job.id}-${++schedule}.md`,
          `---\nschedule: ${JSON.stringify(trigger.cron)}\n---\nRun the ${job.id} playbook with current evidence. ${sink}\n`,
        );
      }
    if (job.macos) {
      put(
        'mac-client.mjs',
        fs.readFileSync(path.join(root, job.macos.hostProfile ? 'host-client.mjs' : 'mac-client.mjs')),
      );
      put(
        'mcp.json',
        JSON.stringify(
          {
            $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
            mcpServers: {
              macos: {
                type: 'stdio',
                command: 'node',
                args: ['${PLUGIN_ROOT}/mac-client.mjs'],
                env: {
                  MAC_WORKER_URL: job.macos.url,
                  MAC_WORKER_RECIPES: JSON.stringify(job.macos.recipes),
                  MAC_WORKER_TOKEN: 'placeholder',
                  NODE_USE_ENV_PROXY: '1',
                  ...(job.macos.hostProfile ? { MAC_HOST_PROFILE: job.macos.hostProfile } : {}),
                },
              },
            },
          },
          null,
          2,
        ),
      );
    }
  }
  // Build into a sibling directory and validate using NanoClaw's own reader
  // before replacing generated templates. Hand-authored inputs live elsewhere.
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staged = fs.mkdtempSync(`${output}.staging-`);
  try {
    for (const [name, content] of files) {
      fs.mkdirSync(path.dirname(path.join(staged, name)), { recursive: true });
      fs.writeFileSync(path.join(staged, name), content);
    }
    for (const job of config.jobs) {
      const result = parseTemplate(path.join(staged, job.id));
      if (result.report.length) throw new Error(result.report.join('\n'));
    }
    fs.rmSync(output, { recursive: true, force: true });
    fs.renameSync(staged, output);
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
  return [...files.keys()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const config = loadConfig(process.argv[2] ?? path.join(root, 'jobs.example.json'));
  const files = compile(config, root, path.join(root, 'generated', 'templates'));
  console.log(`Validated ${config.jobs.length} jobs; wrote ${files.length} template files. Schedules stamp paused.`);
}
