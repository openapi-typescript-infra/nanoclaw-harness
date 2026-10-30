import readline from 'node:readline';

const origin = new URL(process.env.MAC_WORKER_URL);
if (origin.protocol !== 'https:') throw new Error('MAC_WORKER_URL must use HTTPS');
const recipes = JSON.parse(process.env.MAC_WORKER_RECIPES ?? '[]');
if (!Array.isArray(recipes) || !recipes.length) throw new Error('No macOS recipes configured');
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, code, message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(null, -32700, 'Invalid JSON');
    continue;
  }
  if (request.id === undefined) continue;
  if (request.method === 'initialize') {
    send(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'macos-recipes', version: '1.0.0' },
    });
  } else if (request.method === 'ping') send(request.id, {});
  else if (request.method === 'tools/list') {
    send(request.id, {
      tools: [
        {
          name: 'macos_run',
          description: 'Run one operator-configured recipe inside the macOS VM.',
          inputSchema: {
            type: 'object',
            properties: { recipe: { type: 'string', enum: recipes } },
            required: ['recipe'],
            additionalProperties: false,
          },
        },
      ],
    });
  } else if (request.method === 'tools/call') {
    const args = request.params?.arguments;
    if (
      request.params?.name !== 'macos_run' ||
      !args ||
      !recipes.includes(args.recipe) ||
      Object.keys(args).some((k) => k !== 'recipe')
    ) {
      fail(request.id, -32602, 'Unknown recipe or tool');
      continue;
    }
    try {
      const response = await fetch(new URL('/run', origin), {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.MAC_WORKER_TOKEN ?? 'placeholder'}`,
        },
        body: JSON.stringify({ recipe: args.recipe }),
        signal: AbortSignal.timeout(1_810_000),
      });
      const result = await response.json();
      send(request.id, {
        isError: !response.ok || result.exitCode !== 0,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      });
    } catch {
      send(request.id, {
        isError: true,
        content: [
          { type: 'text', text: 'macOS worker unavailable. Check gateway, TLS, authentication, and worker status.' },
        ],
      });
    }
  } else fail(request.id, -32601, 'Method not found');
}
