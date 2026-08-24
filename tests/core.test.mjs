import test from 'node:test'
import assert from 'node:assert/strict'

import {
  activeSavedPapers,
  autoSavePriorityPapers,
  ensureStateShape,
  isPriorityPaper,
  mergeStates,
  partitionAndRankPapers,
  savePaper,
  scorePaper,
  setPaperVote,
  unsavePaper
} from '../static/cosmos-briefing-7f3c91/core.mjs'

const priorityAuthors = [
  { name: 'Ivan Martinez Soler', aliases: ['Iván Martínez-Soler', 'I. Martinez-Soler'] }
]

function paper(overrides = {}) {
  return {
    id: '2608.10000',
    title: 'Dark energy in scalar tensor gravity',
    authors: ['Iván Martínez-Soler', 'Someone Else'],
    categories: ['astro-ph.CO', 'gr-qc'],
    primary_category: 'astro-ph.CO',
    published: '2026-08-24T00:00:00Z',
    listing_type: 'new',
    url: 'https://arxiv.org/abs/2608.10000',
    features: {
      topics: [
        { term: 'dark energy', weight: 4 },
        { term: 'scalar tensor', weight: 3 }
      ]
    },
    ...overrides
  }
}

test('priority matching handles aliases and accents', () => {
  assert.equal(isPriorityPaper(paper(), priorityAuthors), true)
})

test('a priority paper is auto-saved and an explicit removal persists', () => {
  let state = ensureStateShape({ priority_authors: priorityAuthors })
  state = autoSavePriorityPapers(state, [paper()], '2026-08-24T01:00:00Z')
  assert.equal(activeSavedPapers(state).length, 1)
  assert.equal(activeSavedPapers(state)[0].auto, true)

  state = unsavePaper(state, paper().id, '2026-08-24T02:00:00Z')
  state = autoSavePriorityPapers(state, [paper()], '2026-08-24T03:00:00Z')
  assert.equal(activeSavedPapers(state).length, 0)
  assert.equal(state.auto_save_opt_out[paper().id].value, true)

  state = savePaper(state, paper(), { timestamp: '2026-08-24T04:00:00Z' })
  assert.equal(activeSavedPapers(state).length, 1)
  assert.equal(state.auto_save_opt_out[paper().id].value, false)
})

test('newer opt-out decisions survive state merges', () => {
  const base = ensureStateShape({ priority_authors: priorityAuthors })
  const local = savePaper(
    unsavePaper(base, paper().id, '2026-08-24T02:00:00Z'),
    paper(),
    { timestamp: '2026-08-24T04:00:00Z' }
  )
  const remote = unsavePaper(base, paper().id, '2026-08-24T03:00:00Z')
  const merged = mergeStates(local, remote, priorityAuthors)
  assert.equal(merged.auto_save_opt_out[paper().id].value, false)
  assert.equal(activeSavedPapers(merged).length, 1)
})

test('an upvote raises related topics and authors above unrelated papers', () => {
  let state = ensureStateShape({ priority_authors: [] })
  state = setPaperVote(state, paper(), 1, '2026-08-24T01:00:00Z')

  const related = paper({ id: '2608.10001', authors: ['Iván Martínez-Soler'] })
  const unrelated = paper({
    id: '2608.10002',
    title: 'Black hole ringdown catalogue',
    authors: ['Different Person'],
    categories: ['gr-qc'],
    features: { topics: [{ term: 'black holes', weight: 4 }] }
  })
  assert.ok(scorePaper(related, state) > scorePaper(unrelated, state))
})

test('priority, normal, and cross papers are partitioned independently', () => {
  const state = ensureStateShape({ priority_authors: priorityAuthors })
  const sections = partitionAndRankPapers([
    paper(),
    paper({ id: '2608.10001', authors: ['Other Author'] }),
    paper({ id: '2608.10002', authors: ['Other Author'], listing_type: 'cross' })
  ], state)
  assert.equal(sections.priority.length, 1)
  assert.equal(sections.papers.length, 1)
  assert.equal(sections.cross.length, 1)
})

test('an explicitly empty priority list remains empty', () => {
  const state = ensureStateShape({ priority_authors: [] }, priorityAuthors)
  assert.deepEqual(state.priority_authors, [])
})

test('an untrained section preserves the arXiv listing order', () => {
  const state = ensureStateShape({ priority_authors: [] })
  const sections = partitionAndRankPapers([
    paper({ id: '2608.10002', authors: ['Other Author'], listing_order: 2 }),
    paper({ id: '2608.10000', authors: ['Other Author'], listing_order: 0 }),
    paper({ id: '2608.10001', authors: ['Other Author'], listing_order: 1 })
  ], state)
  assert.deepEqual(sections.papers.map(item => item.listing_order), [0, 1, 2])
})
