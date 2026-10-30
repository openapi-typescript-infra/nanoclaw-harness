// Versioned HTTP contract only: no imports from the host service's repository.
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
export class CompanyHost {
  constructor({ url, profile, recipes, token = 'placeholder' }) {
    this.origin = new URL(url);
    if (this.origin.protocol !== 'https:' && this.origin.hostname !== '127.0.0.1')
      throw new Error('Host requires HTTPS');
    this.profile = profile;
    this.recipes = recipes;
    this.token = token;
    this.lease = null;
    this.requestId = `agent-${randomUUID()}`;
  }
  async call(method, route, input) {
    const response = await fetch(new URL(`/v1/${route}`, this.origin), {
      method,
      redirect: 'error',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(3660000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? 'Host request failed');
    return value;
  }
  async acquire() {
    if (this.lease) return this.lease;
    const capabilities = await this.call('GET', 'capabilities');
    if (capabilities.apiVersion !== 1 || !capabilities.profiles.includes(this.profile))
      throw new Error('Host API or profile mismatch');
    this.lease = await this.call('POST', 'leases', {
      requestId: this.requestId,
      profile: this.profile,
      kind: 'agent',
      ttlSeconds: 7200,
    });
    this.timer = setInterval(() => this.call('POST', `leases/${this.lease.id}/renew`, {}).catch(() => {}), 60000);
    this.timer.unref();
    for (;;) {
      const lease = await this.call('GET', `leases/${this.lease.id}`);
      if (lease.status === 'ready') return lease;
      if (!['queued', 'starting'].includes(lease.status)) throw new Error(`Host lease ${lease.status}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  async run(recipe) {
    if (!this.recipes.includes(recipe)) throw new Error('Unknown recipe');
    await this.acquire();
    return this.call('POST', `leases/${this.lease.id}/run`, { recipe });
  }
  async release() {
    clearInterval(this.timer);
    if (this.lease) {
      await this.call('DELETE', `leases/${this.lease.id}`);
      this.lease = null;
      this.requestId = `agent-${randomUUID()}`;
    }
    return { released: true };
  }
}
if (process.env.MAC_HOST_PROFILE) {
  const client = new CompanyHost({
    url: process.env.MAC_WORKER_URL,
    profile: process.env.MAC_HOST_PROFILE,
    recipes: JSON.parse(process.env.MAC_WORKER_RECIPES ?? '[]'),
    token: process.env.MAC_WORKER_TOKEN ?? 'placeholder',
  });
  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      client
        .release()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  for await (const line of input) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.id === undefined) continue;
    if (request.method === 'initialize')
      reply(request.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'company-host', version: '1.0.0' },
      });
    else if (request.method === 'ping') reply(request.id, {});
    else if (request.method === 'tools/list')
      reply(request.id, {
        tools: [
          {
            name: 'macos_run',
            description: 'Run a configured recipe in this company’s leased VM; repeated calls preserve the same VM.',
            inputSchema: {
              type: 'object',
              properties: { recipe: { type: 'string', enum: client.recipes } },
              required: ['recipe'],
              additionalProperties: false,
            },
          },
          {
            name: 'macos_release',
            description: 'Release the company VM after completing the job.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      });
    else if (request.method === 'tools/call') {
      try {
        const args = request.params?.arguments ?? {};
        let value;
        if (request.params?.name === 'macos_run' && Object.keys(args).length === 1 && typeof args.recipe === 'string')
          value = await client.run(args.recipe);
        else if (request.params?.name === 'macos_release' && !Object.keys(args).length) value = await client.release();
        else throw new Error('Invalid tool arguments');
        reply(request.id, {
          isError: value.exitCode !== undefined && value.exitCode !== 0,
          content: [{ type: 'text', text: JSON.stringify(value) }],
        });
      } catch {
        reply(request.id, {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Host operation failed. Check queue, lease, profile and authentication; retry explicitly.',
            },
          ],
        });
      }
    } else
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n',
      );
  }
  await client.release().catch(() => {});
}
