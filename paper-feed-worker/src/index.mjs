const API_VERSION = '2026-03-10'
const STATE_SCHEMA_VERSION = 1
const MAX_BODY_BYTES = 8_000_000

function jsonResponse(payload, status = 200, corsHeaders = {}) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders
    }
  })
}

function parseAllowedOrigins(value) {
  const origins = String(value || '*')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  return origins.length ? origins : ['*']
}

function corsForRequest(request, env) {
  const origin = request.headers.get('Origin') || ''
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS)
  const wildcard = allowed.includes('*')
  const permitted = !origin || wildcard || allowed.includes(origin)
  const allowOrigin = wildcard ? '*' : permitted && origin ? origin : allowed[0]
  return {
    permitted,
    headers: {
      'Access-Control-Allow-Origin': allowOrigin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Paper-Feed-Key',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    }
  }
}

export function constantTimeEqual(left, right) {
  const a = String(left || '')
  const b = String(right || '')
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index % Math.max(a.length, 1)) || 0) ^
      (b.charCodeAt(index % Math.max(b.length, 1)) || 0)
  }
  return difference === 0
}

export function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(String(value))
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

export function base64ToUtf8(value) {
  const binary = atob(String(value || '').replace(/\s+/g, ''))
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function encodedPath(path) {
  return String(path || '')
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

function githubConfiguration(env) {
  const configuration = {
    owner: String(env.GITHUB_OWNER || '').trim(),
    repo: String(env.GITHUB_REPO || '').trim(),
    defaultBranch: String(env.GITHUB_DEFAULT_BRANCH || 'hugo-dem2').trim(),
    stateBranch: String(env.GITHUB_STATE_BRANCH || 'paper-feed-state').trim(),
    statePath: String(env.GITHUB_STATE_PATH || 'paper-feed-state.json').trim(),
    initialStatePath: String(env.GITHUB_INITIAL_STATE_PATH || 'static/cosmos-briefing-7f3c91/data/state.json').trim(),
    token: String(env.GITHUB_TOKEN || '').trim()
  }
  for (const [name, value] of Object.entries(configuration)) {
    if (!value) {
      throw new Error(`Missing Worker setting ${name}`)
    }
  }
  return configuration
}

async function githubRequest(configuration, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${configuration.token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'sergio-paper-feed-worker',
      ...(options.headers || {})
    }
  })
  const payload = await response.json().catch(() => ({}))
  return { response, payload }
}

async function getContentFile(configuration, path, branch) {
  const query = new URLSearchParams({ ref: branch })
  const result = await githubRequest(
    configuration,
    `/repos/${encodeURIComponent(configuration.owner)}/${encodeURIComponent(configuration.repo)}/contents/${encodedPath(path)}?${query}`
  )
  if (result.response.status === 404) {
    return null
  }
  if (!result.response.ok) {
    throw new Error(result.payload.message || `GitHub returned ${result.response.status}`)
  }
  let encodedContent = result.payload.content || ''
  if (!encodedContent && result.payload.git_url) {
    const blobUrl = new URL(result.payload.git_url)
    if (blobUrl.hostname !== 'api.github.com') {
      throw new Error('GitHub returned an unexpected blob URL')
    }
    const blob = await githubRequest(
      configuration,
      `${blobUrl.pathname}${blobUrl.search}`
    )
    if (!blob.response.ok) {
      throw new Error(blob.payload.message || 'Could not read the state blob')
    }
    encodedContent = blob.payload.content || ''
  }
  if (!encodedContent) {
    throw new Error(`GitHub returned no content for ${path}`)
  }
  const text = base64ToUtf8(encodedContent)
  return {
    sha: result.payload.sha,
    state: JSON.parse(text)
  }
}

async function branchExists(configuration, branch) {
  const result = await githubRequest(
    configuration,
    `/repos/${encodeURIComponent(configuration.owner)}/${encodeURIComponent(configuration.repo)}/git/ref/heads/${encodeURIComponent(branch)}`
  )
  if (result.response.status === 404) {
    return false
  }
  if (!result.response.ok) {
    throw new Error(result.payload.message || `Could not inspect branch ${branch}`)
  }
  return true
}

async function ensureStateBranch(configuration) {
  if (await branchExists(configuration, configuration.stateBranch)) {
    return
  }

  const defaultRef = await githubRequest(
    configuration,
    `/repos/${encodeURIComponent(configuration.owner)}/${encodeURIComponent(configuration.repo)}/git/ref/heads/${encodeURIComponent(configuration.defaultBranch)}`
  )
  if (!defaultRef.response.ok) {
    throw new Error(defaultRef.payload.message || 'Could not read the default branch')
  }
  const sha = defaultRef.payload.object?.sha
  if (!sha) {
    throw new Error('The default branch response did not contain a commit SHA')
  }

  const created = await githubRequest(
    configuration,
    `/repos/${encodeURIComponent(configuration.owner)}/${encodeURIComponent(configuration.repo)}/git/refs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: `refs/heads/${configuration.stateBranch}`,
        sha
      })
    }
  )
  if (!created.response.ok && created.response.status !== 422) {
    throw new Error(created.payload.message || 'Could not create the state branch')
  }
}

export function normalizeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('State must be a JSON object')
  }
  const state = structuredClone(input)
  state.schema_version = STATE_SCHEMA_VERSION
  state.revision = Number.isFinite(Number(state.revision)) ? Number(state.revision) : 0
  state.updated_at = String(state.updated_at || new Date().toISOString())
  state.priority_authors = Array.isArray(state.priority_authors) ? state.priority_authors : []
  state.votes = state.votes && typeof state.votes === 'object' ? state.votes : {}
  state.saved = state.saved && typeof state.saved === 'object' ? state.saved : {}
  state.auto_save_opt_out = state.auto_save_opt_out && typeof state.auto_save_opt_out === 'object'
    ? state.auto_save_opt_out
    : {}
  state.model = state.model && typeof state.model === 'object'
    ? state.model
    : { authors: {}, topics: {}, categories: {} }
  return state
}

async function readInitialState(configuration) {
  const initial = await getContentFile(
    configuration,
    configuration.initialStatePath,
    configuration.defaultBranch
  )
  if (!initial) {
    throw new Error('The initial state file was not found on the default branch')
  }
  return normalizeState(initial.state)
}

async function readRemoteState(configuration) {
  const exists = await branchExists(configuration, configuration.stateBranch)
  if (!exists) {
    return { state: await readInitialState(configuration), sha: null, branchExists: false }
  }
  const stored = await getContentFile(
    configuration,
    configuration.statePath,
    configuration.stateBranch
  )
  if (!stored) {
    return { state: await readInitialState(configuration), sha: null, branchExists: true }
  }
  return { state: normalizeState(stored.state), sha: stored.sha, branchExists: true }
}

async function writeRemoteState(configuration, state, sha) {
  await ensureStateBranch(configuration)
  const body = {
    message: 'Update paper feed state [skip ci]',
    content: utf8ToBase64(`${JSON.stringify(state, null, 2)}\n`),
    branch: configuration.stateBranch
  }
  if (sha) {
    body.sha = sha
  }

  const result = await githubRequest(
    configuration,
    `/repos/${encodeURIComponent(configuration.owner)}/${encodeURIComponent(configuration.repo)}/contents/${encodedPath(configuration.statePath)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  )
  if (!result.response.ok) {
    const error = new Error(result.payload.message || `GitHub returned ${result.response.status}`)
    error.status = result.response.status
    throw error
  }
}

async function parseRequestJson(request) {
  const contentLength = Number(request.headers.get('Content-Length') || 0)
  if (contentLength > MAX_BODY_BYTES) {
    throw new Error('Request body is too large')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new Error('Request body is too large')
  }
  return JSON.parse(text)
}

async function handleGetState(configuration, corsHeaders) {
  const remote = await readRemoteState(configuration)
  return jsonResponse({ state: remote.state }, 200, corsHeaders)
}

async function handlePostState(request, env, configuration, corsHeaders) {
  if (!env.WRITE_KEY || !constantTimeEqual(request.headers.get('X-Paper-Feed-Key'), env.WRITE_KEY)) {
    return jsonResponse({ error: 'Invalid write key' }, 401, corsHeaders)
  }

  let body
  try {
    body = await parseRequestJson(request)
  } catch (error) {
    return jsonResponse({ error: `Invalid request body. ${error.message}` }, 400, corsHeaders)
  }

  let incoming
  try {
    incoming = normalizeState(body.state)
  } catch (error) {
    return jsonResponse({ error: error.message }, 400, corsHeaders)
  }
  const baseRevision = Number(body.base_revision)
  if (!Number.isFinite(baseRevision) || baseRevision < 0) {
    return jsonResponse({ error: 'base_revision must be a non-negative number' }, 400, corsHeaders)
  }

  const remote = await readRemoteState(configuration)
  const remoteRevision = Number(remote.state.revision || 0)
  if (baseRevision !== remoteRevision) {
    return jsonResponse({
      error: 'State revision conflict',
      state: remote.state
    }, 409, corsHeaders)
  }

  incoming.revision = remoteRevision + 1
  incoming.updated_at = new Date().toISOString()
  try {
    await writeRemoteState(configuration, incoming, remote.sha)
  } catch (error) {
    if (error.status === 409 || error.status === 422) {
      const latest = await readRemoteState(configuration)
      return jsonResponse({
        error: 'State revision conflict',
        state: latest.state
      }, 409, corsHeaders)
    }
    throw error
  }
  return jsonResponse({ state: incoming }, 200, corsHeaders)
}

export default {
  async fetch(request, env) {
    const cors = corsForRequest(request, env)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: cors.permitted ? 204 : 403,
        headers: cors.headers
      })
    }
    if (!cors.permitted) {
      return jsonResponse({ error: 'Origin is not allowed' }, 403, cors.headers)
    }

    const url = new URL(request.url)
    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ ok: true }, 200, cors.headers)
    }
    if (url.pathname !== '/state') {
      return jsonResponse({ error: 'Not found' }, 404, cors.headers)
    }

    try {
      const configuration = githubConfiguration(env)
      if (request.method === 'GET') {
        return await handleGetState(configuration, cors.headers)
      }
      if (request.method === 'POST') {
        return await handlePostState(request, env, configuration, cors.headers)
      }
      return jsonResponse({ error: 'Method not allowed' }, 405, cors.headers)
    } catch (error) {
      console.error(error)
      return jsonResponse({ error: error.message || 'Unexpected Worker error' }, 500, cors.headers)
    }
  }
}
