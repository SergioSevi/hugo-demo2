import test from 'node:test'
import assert from 'node:assert/strict'

import {
  base64ToUtf8,
  constantTimeEqual,
  normalizeState,
  utf8ToBase64
} from '../src/index.mjs'

test('UTF-8 JSON survives base64 conversion', () => {
  const original = JSON.stringify({ author: 'Iván Martínez-Soler', symbol: 'φ' })
  assert.equal(base64ToUtf8(utf8ToBase64(original)), original)
})

test('write keys compare correctly', () => {
  assert.equal(constantTimeEqual('correct horse', 'correct horse'), true)
  assert.equal(constantTimeEqual('correct horse', 'wrong horse'), false)
  assert.equal(constantTimeEqual('', 'x'), false)
})

test('state normalization supplies required containers', () => {
  const state = normalizeState({ revision: '4' })
  assert.equal(state.schema_version, 1)
  assert.equal(state.revision, 4)
  assert.deepEqual(state.votes, {})
  assert.deepEqual(state.saved, {})
})

import worker from '../src/index.mjs'

const workerEnv = {
  GITHUB_OWNER: 'SergioSevi',
  GITHUB_REPO: 'hugo-demo2',
  GITHUB_DEFAULT_BRANCH: 'hugo-dem2',
  GITHUB_STATE_BRANCH: 'paper-feed-state',
  GITHUB_STATE_PATH: 'paper-feed-state.json',
  GITHUB_INITIAL_STATE_PATH: 'static/cosmos-briefing-7f3c91/data/state.json',
  GITHUB_TOKEN: 'test-token',
  WRITE_KEY: 'test-write-key',
  ALLOWED_ORIGINS: '*'
}

function githubJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('GET state falls back to the seed file when the state branch does not exist', async () => {
  const originalFetch = globalThis.fetch
  const seed = normalizeState({
    revision: 0,
    priority_authors: [{ name: 'Mark Trodden', aliases: [] }]
  })
  const calls = []
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    calls.push({ url: url.pathname + url.search, method: options.method || 'GET' })
    if (url.pathname.endsWith('/git/ref/heads/paper-feed-state')) {
      return githubJson({ message: 'Not Found' }, 404)
    }
    if (url.pathname.includes('/contents/static/cosmos-briefing-7f3c91/data/state.json')) {
      return githubJson({ sha: 'seed-sha', content: utf8ToBase64(JSON.stringify(seed)) })
    }
    throw new Error(`Unexpected GitHub request ${url}`)
  }

  try {
    const response = await worker.fetch(new Request('https://worker.example/state'), workerEnv)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.state.revision, 0)
    assert.equal(payload.state.priority_authors[0].name, 'Mark Trodden')
    assert.equal(calls.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('POST state creates the state branch and writes a new revision', async () => {
  const originalFetch = globalThis.fetch
  const seed = normalizeState({ revision: 0, priority_authors: [] })
  const calls = []
  let stateBranchChecks = 0
  let writtenState = null

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    const method = options.method || 'GET'
    calls.push({ url: url.pathname + url.search, method })

    if (url.pathname.endsWith('/git/ref/heads/paper-feed-state') && method === 'GET') {
      stateBranchChecks += 1
      return githubJson({ message: 'Not Found' }, 404)
    }
    if (url.pathname.includes('/contents/static/cosmos-briefing-7f3c91/data/state.json')) {
      return githubJson({ sha: 'seed-sha', content: utf8ToBase64(JSON.stringify(seed)) })
    }
    if (url.pathname.endsWith('/git/ref/heads/hugo-dem2') && method === 'GET') {
      return githubJson({ object: { sha: 'default-commit-sha' } })
    }
    if (url.pathname.endsWith('/git/refs') && method === 'POST') {
      const body = JSON.parse(options.body)
      assert.equal(body.ref, 'refs/heads/paper-feed-state')
      assert.equal(body.sha, 'default-commit-sha')
      return githubJson({ ref: body.ref }, 201)
    }
    if (url.pathname.endsWith('/contents/paper-feed-state.json') && method === 'PUT') {
      const body = JSON.parse(options.body)
      writtenState = JSON.parse(base64ToUtf8(body.content))
      assert.equal(body.branch, 'paper-feed-state')
      assert.equal('sha' in body, false)
      return githubJson({ content: { sha: 'new-state-sha' } }, 201)
    }
    throw new Error(`Unexpected GitHub request ${method} ${url}`)
  }

  const request = new Request('https://worker.example/state', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Paper-Feed-Key': workerEnv.WRITE_KEY
    },
    body: JSON.stringify({ base_revision: 0, state: seed })
  })

  try {
    const response = await worker.fetch(request, workerEnv)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.state.revision, 1)
    assert.equal(writtenState.revision, 1)
    assert.equal(stateBranchChecks, 2)
    assert.ok(calls.some(call => call.method === 'POST' && call.url.endsWith('/git/refs')))
    assert.ok(calls.some(call => call.method === 'PUT' && call.url.endsWith('/contents/paper-feed-state.json')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('POST state rejects an invalid write key before contacting GitHub', async () => {
  const originalFetch = globalThis.fetch
  let contactedGitHub = false
  globalThis.fetch = async () => {
    contactedGitHub = true
    throw new Error('GitHub should not be contacted')
  }

  try {
    const response = await worker.fetch(new Request('https://worker.example/state', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Paper-Feed-Key': 'wrong-key'
      },
      body: JSON.stringify({ base_revision: 0, state: { revision: 0 } })
    }), workerEnv)
    assert.equal(response.status, 401)
    assert.equal(contactedGitHub, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET state follows the Git blob URL when inline content is omitted', async () => {
  const originalFetch = globalThis.fetch
  const stored = normalizeState({
    revision: 12,
    priority_authors: [{ name: 'Djuna Croon', aliases: [] }]
  })

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    const method = options.method || 'GET'
    if (url.pathname.endsWith('/git/ref/heads/paper-feed-state') && method === 'GET') {
      return githubJson({ object: { sha: 'state-commit-sha' } })
    }
    if (url.pathname.endsWith('/contents/paper-feed-state.json') && method === 'GET') {
      return githubJson({
        sha: 'large-state-sha',
        content: '',
        encoding: 'none',
        git_url: 'https://api.github.com/repos/SergioSevi/hugo-demo2/git/blobs/large-state-sha'
      })
    }
    if (url.pathname.endsWith('/git/blobs/large-state-sha') && method === 'GET') {
      return githubJson({ content: utf8ToBase64(JSON.stringify(stored)), encoding: 'base64' })
    }
    throw new Error(`Unexpected GitHub request ${method} ${url}`)
  }

  try {
    const response = await worker.fetch(new Request('https://worker.example/state'), workerEnv)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.state.revision, 12)
    assert.equal(payload.state.priority_authors[0].name, 'Djuna Croon')
  } finally {
    globalThis.fetch = originalFetch
  }
})
