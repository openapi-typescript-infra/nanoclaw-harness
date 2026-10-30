import { applySkill } from '../scripts/skill-apply.js';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Materialize code only. Account connection and service installation belong to
// the interactive deployment step, never to the image build.
for (const name of ['add-onecli', 'add-codex', 'add-slack']) {
  const result = await applySkill(path.resolve('.claude/skills', name), process.cwd(), {
    exec: (command) => execSync(command, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }),
    skipEffects: ['external', 'build', 'test', 'restart', 'fetch'],
  });
  if (result.agentTasks.length) {
    throw new Error(`${name}: ${result.agentTasks.map((task) => JSON.stringify(task)).join('\n')}`);
  }
  console.log(`${name}: source installed; credentials and runtime setup deferred`);
}
