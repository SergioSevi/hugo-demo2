const STATE_SCHEMA_VERSION = 1

const GENERIC_TOPIC_WORDS = new Set([
  'about', 'after', 'against', 'analysis', 'approach', 'based', 'between', 'beyond',
  'constraints', 'data', 'different', 'effects', 'energy', 'field', 'fields', 'first',
  'framework', 'from', 'general', 'high', 'impact', 'including', 'large', 'model',
  'models', 'new', 'novel', 'observations', 'paper', 'physics', 'possible', 'present',
  'properties', 'results', 'scale', 'scales', 'show', 'study', 'system', 'theory',
  'through', 'towards', 'using', 'with', 'without'
])

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function toTimestamp(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}

function newestTimestamp(...values) {
  return values.reduce((best, value) => {
    return toTimestamp(value) > toTimestamp(best) ? value : best
  }, '')
}

function roundWeight(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000
}

export function normalizeName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function nameSignature(name) {
  const tokens = normalizeName(name).split(' ').filter(Boolean)
  if (!tokens.length) {
    return { first: '', surname: '' }
  }
  return {
    first: tokens[0],
    surname: tokens[tokens.length - 1]
  }
}

export function normalizePriorityEntry(entry) {
  if (typeof entry === 'string') {
    return { name: entry.trim(), aliases: [] }
  }
  return {
    name: String(entry?.name || '').trim(),
    aliases: Array.isArray(entry?.aliases)
      ? entry.aliases.map(alias => String(alias).trim()).filter(Boolean)
      : []
  }
}

function authorMatchesCandidate(author, candidate) {
  const normalizedAuthor = normalizeName(author)
  const normalizedCandidate = normalizeName(candidate)
  if (!normalizedAuthor || !normalizedCandidate) {
    return false
  }
  if (normalizedAuthor === normalizedCandidate) {
    return true
  }

  const authorSignature = nameSignature(author)
  const candidateSignature = nameSignature(candidate)
  if (authorSignature.surname !== candidateSignature.surname) {
    return false
  }
  if (!authorSignature.first || !candidateSignature.first) {
    return false
  }
  return authorSignature.first[0] === candidateSignature.first[0]
}

export function priorityMatchesForPaper(paper, priorityAuthors) {
  const authors = Array.isArray(paper?.authors) ? paper.authors : []
  const entries = (Array.isArray(priorityAuthors) ? priorityAuthors : [])
    .map(normalizePriorityEntry)
    .filter(entry => entry.name)

  const matches = []
  for (const entry of entries) {
    const candidates = [entry.name, ...entry.aliases]
    const matched = authors.some(author => {
      return candidates.some(candidate => authorMatchesCandidate(author, candidate))
    })
    if (matched) {
      matches.push(entry.name)
    }
  }
  return matches
}

export function isPriorityPaper(paper, priorityAuthors) {
  return priorityMatchesForPaper(paper, priorityAuthors).length > 0
}

function fallbackTopicFeatures(paper) {
  const title = String(paper?.title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
  const tokens = title
    .split(/\s+/)
    .filter(token => token.length >= 3 && !GENERIC_TOPIC_WORDS.has(token))

  const weights = new Map()
  for (const token of tokens) {
    weights.set(token, (weights.get(token) || 0) + 1.5)
  }
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const phrase = `${tokens[index]} ${tokens[index + 1]}`
    weights.set(phrase, (weights.get(phrase) || 0) + 2.5)
  }

  return [...weights.entries()]
    .map(([term, weight]) => ({ term, weight: roundWeight(weight) }))
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, 30)
}

export function voteFeaturesForPaper(paper) {
  const providedTopics = Array.isArray(paper?.features?.topics)
    ? paper.features.topics
        .map(item => ({
          term: String(item?.term || '').trim().toLowerCase(),
          weight: Number(item?.weight || 0)
        }))
        .filter(item => item.term && Number.isFinite(item.weight) && item.weight > 0)
    : []

  return {
    authors: (Array.isArray(paper?.authors) ? paper.authors : [])
      .map(normalizeName)
      .filter(Boolean),
    topics: providedTopics.length ? providedTopics : fallbackTopicFeatures(paper),
    categories: (Array.isArray(paper?.categories) ? paper.categories : [])
      .map(category => String(category).trim())
      .filter(Boolean)
  }
}

export function emptyModel() {
  return {
    authors: {},
    topics: {},
    categories: {}
  }
}

export function recomputeModel(state) {
  const model = emptyModel()
  const votes = Object.values(state?.votes || {})

  for (const vote of votes) {
    const value = Number(vote?.value || 0)
    if (value !== 1 && value !== -1) {
      continue
    }
    const features = vote?.features || {}
    const authors = Array.isArray(features.authors) ? features.authors : []
    const authorScale = authors.length ? 3.5 / Math.sqrt(authors.length) : 0
    for (const author of authors) {
      const key = normalizeName(author)
      if (!key) {
        continue
      }
      model.authors[key] = roundWeight((model.authors[key] || 0) + value * authorScale)
    }

    const topics = Array.isArray(features.topics) ? features.topics : []
    for (const topic of topics) {
      const key = String(topic?.term || '').trim().toLowerCase()
      const weight = Number(topic?.weight || 0)
      if (!key || !Number.isFinite(weight)) {
        continue
      }
      model.topics[key] = roundWeight((model.topics[key] || 0) + value * weight)
    }

    const categories = Array.isArray(features.categories) ? features.categories : []
    const categoryScale = categories.length ? 0.75 / Math.sqrt(categories.length) : 0
    for (const category of categories) {
      const key = String(category || '').trim()
      if (!key) {
        continue
      }
      model.categories[key] = roundWeight((model.categories[key] || 0) + value * categoryScale)
    }
  }

  return model
}

export function ensureStateShape(input, defaultPriorityAuthors = []) {
  const now = new Date().toISOString()
  const state = clone(input) || {}
  state.schema_version = STATE_SCHEMA_VERSION
  state.revision = Number.isFinite(Number(state.revision)) ? Number(state.revision) : 0
  state.updated_at = state.updated_at || now
  state.priority_authors = Array.isArray(state.priority_authors)
    ? state.priority_authors.map(normalizePriorityEntry).filter(entry => entry.name)
    : defaultPriorityAuthors.map(normalizePriorityEntry).filter(entry => entry.name)
  state.priority_authors_updated_at = state.priority_authors_updated_at || state.updated_at
  state.votes = state.votes && typeof state.votes === 'object' ? state.votes : {}
  state.saved = state.saved && typeof state.saved === 'object' ? state.saved : {}
  state.auto_save_opt_out = state.auto_save_opt_out && typeof state.auto_save_opt_out === 'object'
    ? Object.fromEntries(Object.entries(state.auto_save_opt_out).map(([id, record]) => {
        if (typeof record === 'string') {
          return [id, { value: true, updated_at: record }]
        }
        return [id, {
          value: Boolean(record?.value),
          updated_at: record?.updated_at || state.updated_at
        }]
      }))
    : {}
  state.model = recomputeModel(state)
  return state
}

export function setPaperVote(inputState, paper, requestedValue, timestamp = new Date().toISOString()) {
  const state = ensureStateShape(inputState)
  const id = String(paper?.id || '').trim()
  if (!id) {
    throw new Error('Cannot vote on a paper without an id')
  }
  const value = Number(requestedValue)
  if (value !== 1 && value !== -1) {
    throw new Error('Vote must be 1 or -1')
  }

  const existing = state.votes[id]
  if (existing?.value === value) {
    delete state.votes[id]
  } else {
    state.votes[id] = {
      id,
      value,
      updated_at: timestamp,
      features: voteFeaturesForPaper(paper)
    }
  }
  state.updated_at = timestamp
  state.model = recomputeModel(state)
  return state
}

export function paperToSavedRecord(paper, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString()
  return {
    id: String(paper?.id || ''),
    title: String(paper?.title || ''),
    url: String(paper?.url || ''),
    published: String(paper?.published || ''),
    authors: Array.isArray(paper?.authors) ? paper.authors.slice() : [],
    primary_category: String(paper?.primary_category || ''),
    saved_at: options.savedAt || timestamp,
    updated_at: timestamp,
    auto: Boolean(options.auto),
    deleted: false
  }
}

export function savePaper(inputState, paper, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString()
  const state = ensureStateShape(inputState)
  const id = String(paper?.id || '').trim()
  if (!id) {
    throw new Error('Cannot save a paper without an id')
  }

  const previousSavedAt = state.saved[id]?.saved_at
  state.saved[id] = paperToSavedRecord(paper, {
    timestamp,
    savedAt: previousSavedAt || timestamp,
    auto: Boolean(options.auto)
  })
  state.auto_save_opt_out[id] = {
    value: false,
    updated_at: timestamp
  }
  state.updated_at = timestamp
  return state
}

export function unsavePaper(inputState, paperId, timestamp = new Date().toISOString()) {
  const state = ensureStateShape(inputState)
  const id = String(paperId || '').trim()
  if (!id) {
    throw new Error('Cannot unsave a paper without an id')
  }

  const existing = state.saved[id] || { id, title: '', url: '', saved_at: timestamp }
  state.saved[id] = {
    ...existing,
    id,
    deleted: true,
    updated_at: timestamp
  }
  state.auto_save_opt_out[id] = {
    value: true,
    updated_at: timestamp
  }
  state.updated_at = timestamp
  return state
}

export function activeSavedPapers(state) {
  return Object.values(state?.saved || {})
    .filter(record => record && !record.deleted)
    .sort((a, b) => {
      return toTimestamp(b.saved_at) - toTimestamp(a.saved_at) ||
        String(a.title || '').localeCompare(String(b.title || ''))
    })
}

export function autoSavePriorityPapers(inputState, papers, timestamp = new Date().toISOString()) {
  let state = ensureStateShape(inputState)
  for (const paper of Array.isArray(papers) ? papers : []) {
    const id = String(paper?.id || '')
    if (!id || !isPriorityPaper(paper, state.priority_authors)) {
      continue
    }
    if (state.auto_save_opt_out[id]?.value) {
      continue
    }
    const existing = state.saved[id]
    if (existing && !existing.deleted) {
      continue
    }
    state = savePaper(state, paper, { auto: true, timestamp })
  }
  return state
}

export function setPriorityAuthors(inputState, priorityAuthors, timestamp = new Date().toISOString()) {
  const state = ensureStateShape(inputState)
  const seen = new Set()
  state.priority_authors = (Array.isArray(priorityAuthors) ? priorityAuthors : [])
    .map(normalizePriorityEntry)
    .filter(entry => {
      const key = normalizeName(entry.name)
      if (!key || seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
  state.priority_authors_updated_at = timestamp
  state.updated_at = timestamp
  return state
}

export function scorePaper(paper, state) {
  const model = state?.model || emptyModel()
  const features = voteFeaturesForPaper(paper)

  let authorScore = 0
  for (const author of features.authors) {
    authorScore += Number(model.authors?.[normalizeName(author)] || 0)
  }
  if (features.authors.length) {
    authorScore /= Math.sqrt(features.authors.length)
  }

  let topicScore = 0
  let topicNorm = 0
  for (const topic of features.topics) {
    const featureWeight = Number(topic.weight || 0)
    topicScore += Number(model.topics?.[topic.term] || 0) * featureWeight
    topicNorm += featureWeight * featureWeight
  }
  if (topicNorm > 0) {
    topicScore /= Math.sqrt(topicNorm)
  }

  let categoryScore = 0
  for (const category of features.categories) {
    categoryScore += Number(model.categories?.[category] || 0)
  }
  if (features.categories.length) {
    categoryScore /= Math.sqrt(features.categories.length)
  }

  const directVote = Number(state?.votes?.[paper?.id]?.value || 0)
  return roundWeight(authorScore * 8 + topicScore * 2.5 + categoryScore * 1.5 + directVote * 40)
}

export function partitionAndRankPapers(papers, state) {
  const sections = {
    priority: [],
    papers: [],
    cross: []
  }

  for (const paper of Array.isArray(papers) ? papers : []) {
    const enriched = {
      ...paper,
      score: scorePaper(paper, state),
      priority_matches: priorityMatchesForPaper(paper, state?.priority_authors || [])
    }
    if (enriched.priority_matches.length) {
      sections.priority.push(enriched)
    } else if (paper?.listing_type === 'cross') {
      sections.cross.push(enriched)
    } else {
      sections.papers.push(enriched)
    }
  }

  const sorter = (a, b) => {
    return b.score - a.score ||
      Number(a.listing_order ?? Number.MAX_SAFE_INTEGER) - Number(b.listing_order ?? Number.MAX_SAFE_INTEGER) ||
      toTimestamp(b.published) - toTimestamp(a.published) ||
      String(a.title || '').localeCompare(String(b.title || ''))
  }
  sections.priority.sort(sorter)
  sections.papers.sort(sorter)
  sections.cross.sort(sorter)
  return sections
}

function mergeRecordMaps(localMap, remoteMap) {
  const merged = {}
  const ids = new Set([
    ...Object.keys(localMap || {}),
    ...Object.keys(remoteMap || {})
  ])
  for (const id of ids) {
    const localRecord = localMap?.[id]
    const remoteRecord = remoteMap?.[id]
    if (!localRecord) {
      merged[id] = clone(remoteRecord)
    } else if (!remoteRecord) {
      merged[id] = clone(localRecord)
    } else {
      merged[id] = toTimestamp(localRecord.updated_at) >= toTimestamp(remoteRecord.updated_at)
        ? clone(localRecord)
        : clone(remoteRecord)
    }
  }
  return merged
}

export function mergeStates(localInput, remoteInput, defaultPriorityAuthors = []) {
  const local = ensureStateShape(localInput, defaultPriorityAuthors)
  const remote = ensureStateShape(remoteInput, defaultPriorityAuthors)
  const priorityFromLocal = toTimestamp(local.priority_authors_updated_at) >=
    toTimestamp(remote.priority_authors_updated_at)

  const merged = {
    schema_version: STATE_SCHEMA_VERSION,
    revision: Math.max(Number(local.revision || 0), Number(remote.revision || 0)),
    updated_at: newestTimestamp(local.updated_at, remote.updated_at),
    priority_authors: clone(priorityFromLocal ? local.priority_authors : remote.priority_authors),
    priority_authors_updated_at: newestTimestamp(
      local.priority_authors_updated_at,
      remote.priority_authors_updated_at
    ),
    votes: mergeRecordMaps(local.votes, remote.votes),
    saved: mergeRecordMaps(local.saved, remote.saved),
    auto_save_opt_out: mergeRecordMaps(local.auto_save_opt_out, remote.auto_save_opt_out),
    model: emptyModel()
  }
  merged.model = recomputeModel(merged)
  return merged
}

export function topModelEntries(modelSection, limit = 12) {
  return Object.entries(modelSection || {})
    .filter(([, value]) => Number(value) !== 0)
    .sort((a, b) => Math.abs(Number(b[1])) - Math.abs(Number(a[1])) || a[0].localeCompare(b[0]))
    .slice(0, limit)
}
