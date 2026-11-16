import readline from 'node:readline';

const repositories = new Map(
  (process.env.GITHUB_ALLOWED_REPOSITORIES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => [value.toLowerCase(), value]),
);
const api = 'https://api.github.com';
const filesPerPage = 25;
const chunkChars = 12_000;
const maxGitHubFiles = 3_000;
const pinnedFields = {
  expected_head_sha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
};
const offsetField = { type: 'integer', minimum: 0 };
function chunk(text, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
    throw new Error('offset is outside the available text.');
  let end = Math.min(offset + chunkChars, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return { content: text.slice(offset, end), nextOffset: end < text.length ? end : null, totalChars: text.length };
}
async function pinnedPr(repo, number, args) {
  const pr = await pullRequest(repo, number);
  if (args.expected_head_sha?.toLowerCase() !== pr.head.sha.toLowerCase() ||
      (args.expected_base_sha != null && args.expected_base_sha.toLowerCase() !== pr.base.sha.toLowerCase()))
    throw new Error('Pull request revisions changed or were not pinned; restart from current metadata.');
  return pr;
}
async function filePage(repo, number, args) {
  const page = args.page;
  if (!Number.isSafeInteger(page) || page < 1 || page > maxGitHubFiles / filesPerPage)
    throw new Error('page is outside the GitHub changed-file listing limit.');
  const pr = await pinnedPr(repo, number, args);
  const files = await getJson(`${repoPath(repo)}/pulls/${number}/files?per_page=${filesPerPage}&page=${page}`);
  await pinnedPr(repo, number, { ...args, expected_base_sha: pr.base.sha });
  const remaining = pr.changedFiles - (page - 1) * filesPerPage;
  if (!Array.isArray(files) || files.length !== Math.min(filesPerPage, Math.max(0, remaining)))
    throw new Error('GitHub did not return the expected number of changed files.');
  return { pr, files, nextPage: remaining > filesPerPage && page < maxGitHubFiles / filesPerPage ? page + 1 : null };
}

const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, code, message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
const toolError = (id, message) =>
  send(id, { isError: true, content: [{ type: 'text', text: message }] });

function repository(value) {
  if (typeof value !== 'string') throw new Error('Choose a configured GitHub repository.');
  const exact = repositories.get(value.toLowerCase());
  if (!exact) throw new Error('That repository is not in this review workflow’s allowlist.');
  return exact;
}

function pullNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('pull_number must be a positive integer.');
  return value;
}

function repoPath(value) {
  const [owner, name] = value.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(new URL(path, api), {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'NanoClaw-PR-Review',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('GitHub API is unavailable through the configured credential gateway.');
  }
  if (response.status === 401) throw new Error('GitHub credential is missing or invalid for api.github.com.');
  if (response.status === 403) throw new Error('GitHub denied this request; check repository read permissions or API rate limits.');
  if (response.status === 404) throw new Error('Pull request or file was not found, or the configured identity cannot access the private repository.');
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}.`);
  return response.json();
}

const getJson = (path) => request(path);

async function pullRequest(repo, number) {
  const value = await getJson(`${repoPath(repo)}/pulls/${number}`);
  return {
    repository: repo,
    number: value.number,
    title: value.title,
    body: typeof value.body === 'string' ? value.body.slice(0, 8_000) : '',
    url: value.html_url,
    state: value.state,
    draft: value.draft,
    author: value.user?.login ?? null,
    base: { ref: value.base?.ref, sha: value.base?.sha },
    head: { ref: value.head?.ref, sha: value.head?.sha },
    changedFiles: value.changed_files,
    additions: value.additions,
    deletions: value.deletions,
    updatedAt: value.updated_at,
  };
}

const repositoryEnum = [...repositories.values()];
const tools = [
  {
    name: 'github_pr_review_get_pull_request',
    description: 'Read pull request metadata and base/head revisions for one allowlisted repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', enum: repositoryEnum },
        pull_number: { type: 'integer', minimum: 1 },
      },
      required: ['repository', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'github_pr_review_get_pull_request_files',
    description: 'List one page of changed-file metadata. Follow nextPage until null; fetch patch chunks separately for every changed file.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', enum: repositoryEnum },
        pull_number: { type: 'integer', minimum: 1 },
        ...pinnedFields,
        expected_base_sha: pinnedFields.expected_head_sha,
        page: { type: 'integer', minimum: 1 },
      },
      required: ['repository', 'pull_number', 'expected_head_sha', 'expected_base_sha', 'page'],
      additionalProperties: false,
    },
  },
  {
    name: 'github_pr_review_get_pull_request_file',
    description: 'Read a changed file patch or base/head text in chunks. Use nextOffset to read the rest. Base/head text is a fallback for missing or incomplete patches.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', enum: repositoryEnum },
        pull_number: { type: 'integer', minimum: 1 },
        ...pinnedFields,
        expected_base_sha: pinnedFields.expected_head_sha,
        page: { type: 'integer', minimum: 1 },
        path: { type: 'string', minLength: 1, maxLength: 1_000 },
        view: { enum: ['patch', 'base', 'head'] },
        offset: offsetField,
      },
      required: ['repository', 'pull_number', 'expected_head_sha', 'expected_base_sha', 'page', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'github_pr_review_create_comment',
    description: 'Create one top-level pull request conversation comment in an allowlisted repository. Requires explicit user request to publish; validates the PR is open and the head SHA is unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', enum: repositoryEnum },
        pull_number: { type: 'integer', minimum: 1 },
        expected_head_sha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
        body: { type: 'string', minLength: 1, maxLength: 40_000 },
      },
      required: ['repository', 'pull_number', 'expected_head_sha', 'body'],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  const repo = repository(args?.repository);
  const number = pullNumber(args?.pull_number);
  if (name === 'github_pr_review_get_pull_request') return pullRequest(repo, number);
  if (name === 'github_pr_review_create_comment') {
    if (typeof args.body !== 'string' || !args.body.trim() || args.body.length > 40_000)
      throw new Error('body must be non-empty and at most 40000 characters.');
    if (typeof args.expected_head_sha !== 'string' || !/^[0-9a-f]{40}$/i.test(args.expected_head_sha))
      throw new Error('expected_head_sha must be a 40-character Git commit SHA.');
    const current = await pullRequest(repo, number);
    if (current.state !== 'open') throw new Error('Only open pull requests can receive a review comment.');
    if (current.head.sha.toLowerCase() !== args.expected_head_sha.toLowerCase())
      throw new Error('The pull request changed during review; refresh the diff before publishing.');
    const result = await request(`${repoPath(repo)}/issues/${number}/comments`, {
      method: 'POST',
      body: { body: args.body.trim() },
    });
    return { repository: repo, pullNumber: number, url: result.html_url, createdAt: result.created_at };
  }
  if (name === 'github_pr_review_get_pull_request_files') {
    const { pr, files, nextPage } = await filePage(repo, number, args);
    return {
      page: args.page,
      nextPage,
      changedFiles: pr.changedFiles,
      listingIncomplete: pr.changedFiles > maxGitHubFiles,
      files: files.map(file => ({
        path: file.filename, previousPath: file.previous_filename, status: file.status,
        additions: file.additions, deletions: file.deletions,
      })),
    };
  }
  if (name === 'github_pr_review_get_pull_request_file') {
    const { pr, files } = await filePage(repo, number, args);
    const file = files.find(row => row.filename === args.path);
    if (!file) throw new Error('The path is not a changed file on the specified page.');
    const view = args.view ?? 'patch';
    if (view === 'patch') {
      const patch = typeof file.patch === 'string' ? file.patch : '';
      let additions = 0;
      let deletions = 0;
      let inHunk = false;
      for (const line of patch.split('\n')) {
        if (line.startsWith('@@ ')) inHunk = true;
        else if (inHunk && line.startsWith('+')) additions++;
        else if (inHunk && line.startsWith('-')) deletions++;
      }
      const patchComplete = Boolean(patch) && additions === file.additions && deletions === file.deletions;
      return { path: file.filename, view, patchComplete, ...chunk(patch, args.offset) };
    }
    if (view !== 'base' && view !== 'head') throw new Error('Unknown file view.');
    if ((view === 'base' && file.status === 'added') || (view === 'head' && file.status === 'removed'))
      return { path: file.filename, view, absent: true, ...chunk('', args.offset) };

    const path = view === 'base' ? file.previous_filename ?? file.filename : file.filename;
    const sha = view === 'base'
      ? (await getJson(`${repoPath(repo)}/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`)).merge_base_commit?.sha
      : pr.head.sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/i.test(sha))
      throw new Error('GitHub did not return the pinned file revision.');
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const result = await getJson(`${repoPath(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`);
    if (result?.type !== 'file' || result.encoding !== 'base64' || typeof result.content !== 'string')
      throw new Error('GitHub did not return readable text at the selected revision.');
    const bytes = Buffer.from(result.content, 'base64');
    if (bytes.includes(0)) throw new Error('The changed file contains binary data.');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { path, view, sha, ...chunk(content, args.offset) };
  }
  throw new Error('Unknown GitHub review tool.');
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(null, -32700, 'Invalid JSON.');
    continue;
  }
  if (request.id === undefined) continue;
  if (request.method === 'initialize') {
    send(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'github-pr-review', version: '1.2.0' },
    });
  } else if (request.method === 'ping') send(request.id, {});
  else if (request.method === 'tools/list') send(request.id, { tools });
  else if (request.method === 'tools/call') {
    try {
      const result = await callTool(request.params?.name, request.params?.arguments ?? {});
      send(request.id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (error) {
      toolError(request.id, error instanceof Error ? error.message : 'GitHub review request failed.');
    }
  } else if (request.method.startsWith('notifications/')) continue;
  else fail(request.id, -32601, 'Method not found.');
}
