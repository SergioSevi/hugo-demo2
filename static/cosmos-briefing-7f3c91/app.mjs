import {
  activeSavedPapers,
  autoSavePriorityPapers,
  ensureStateShape,
  mergeStates,
  normalizeName,
  partitionAndRankPapers,
  savePaper,
  setPaperVote,
  setPriorityAuthors,
  topModelEntries,
  unsavePaper
} from './core.mjs'

const STORAGE_KEYS = {
  state: 'sergio-paper-feed-state-v1',
  meta: 'sergio-paper-feed-meta-v1',
  sync: 'sergio-paper-feed-sync-v1'
}

const app = {
  config: null,
  paperData: null,
  state: null,
  seedState: null,
  meta: { dirty: false },
  syncSettings: { endpoint: '', key: '' },
  syncTimer: null,
  syncing: false,
  activeTab: 'papers'
}

function parseJsonStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : fallback
  } catch (error) {
    console.warn(`Could not parse ${key}`, error)
    return fallback
  }
}

function persistLocalState() {
  try {
    localStorage.setItem(STORAGE_KEYS.state, JSON.stringify(app.state))
  } catch (error) {
    console.warn('Could not persist the complete state in browser storage', error)
  }
  try {
    localStorage.setItem(STORAGE_KEYS.meta, JSON.stringify(app.meta))
  } catch (error) {
    console.warn('Could not persist paper-feed metadata in browser storage', error)
  }
}

function persistSyncSettings() {
  try {
    localStorage.setItem(STORAGE_KEYS.sync, JSON.stringify(app.syncSettings))
  } catch (error) {
    console.warn('Could not persist repository-sync settings', error)
  }
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    cache: options.cache || 'no-store',
    headers: {
      Accept: 'application/json',
      ...(options.headers || {})
    }
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return response.json()
}

function stateEndpoint() {
  const configured = String(app.syncSettings.endpoint || app.config?.sync?.default_endpoint || '').trim()
  if (!configured) {
    return ''
  }
  const withoutTrailingSlash = configured.replace(/\/+$/, '')
  return withoutTrailingSlash.endsWith('/state')
    ? withoutTrailingSlash
    : `${withoutTrailingSlash}/state`
}

function setSyncStatus(message, mode = 'neutral') {
  const status = document.getElementById('sync-status')
  const headerStatus = document.getElementById('header-sync-status')
  for (const element of [status, headerStatus]) {
    if (!element) {
      continue
    }
    element.textContent = message
    element.dataset.mode = mode
  }
}

function markDirty() {
  app.meta.dirty = true
  persistLocalState()
}

function stateFingerprint(state) {
  return JSON.stringify(state)
}

function mutateState(mutator, options = {}) {
  const before = stateFingerprint(app.state)
  app.state = ensureStateShape(mutator(app.state), app.seedState.priority_authors)
  if (options.autoSave !== false) {
    app.state = autoSavePriorityPapers(app.state, app.paperData.papers)
  }
  if (stateFingerprint(app.state) !== before) {
    markDirty()
  }
  render()
  scheduleSync()
}

function scheduleSync(delay = 1200) {
  clearTimeout(app.syncTimer)
  if (!app.meta.dirty) {
    return
  }
  app.syncTimer = setTimeout(() => {
    syncState().catch(error => {
      console.error(error)
      setSyncStatus('Saved on this browser', 'warning')
    })
  }, delay)
}

async function loadRemoteState() {
  const endpoint = stateEndpoint()
  if (!endpoint) {
    return null
  }
  const payload = await fetchJson(`${endpoint}?t=${Date.now()}`)
  return payload.state || payload
}

async function postRemoteState(baseRevision) {
  const endpoint = stateEndpoint()
  if (!endpoint || !app.syncSettings.key) {
    return null
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Paper-Feed-Key': app.syncSettings.key
    },
    body: JSON.stringify({
      base_revision: baseRevision,
      state: app.state
    })
  })

  const payload = await response.json().catch(() => ({}))
  if (response.status === 409 && payload.state) {
    return { conflict: true, state: payload.state }
  }
  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`)
  }
  return { conflict: false, state: payload.state || payload }
}

async function syncState() {
  if (app.syncing || !app.meta.dirty) {
    return
  }
  const endpoint = stateEndpoint()
  if (!endpoint || !app.syncSettings.key) {
    setSyncStatus('Saved on this browser', 'warning')
    return
  }

  app.syncing = true
  setSyncStatus('Syncing', 'working')
  try {
    let baseRevision = Number(app.state.revision || 0)
    let result = await postRemoteState(baseRevision)
    if (result?.conflict) {
      app.state = mergeStates(app.state, result.state, app.seedState.priority_authors)
      baseRevision = Number(result.state.revision || 0)
      result = await postRemoteState(baseRevision)
    }
    if (!result || result.conflict) {
      throw new Error('The remote state changed twice during synchronization')
    }
    app.state = ensureStateShape(result.state, app.seedState.priority_authors)
    app.meta.dirty = false
    persistLocalState()
    setSyncStatus('Synced to GitHub', 'success')
    render()
  } finally {
    app.syncing = false
  }
}

function createButton(label, className, title, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = label
  button.title = title
  button.setAttribute('aria-label', title)
  button.addEventListener('click', onClick)
  return button
}

function renderPaperRow(paper, options = {}) {
  const row = document.createElement('article')
  row.className = 'paper-row'
  row.dataset.paperId = paper.id
  if (app.state.votes?.[paper.id]?.value === -1) {
    row.classList.add('downvoted')
  }

  const actions = document.createElement('div')
  actions.className = 'paper-actions'

  const vote = Number(app.state.votes?.[paper.id]?.value || 0)
  const upButton = createButton('↑', `icon-button vote-button${vote === 1 ? ' active up' : ''}`, 'Upvote this paper', () => {
    mutateState(state => setPaperVote(state, paper, 1))
  })
  const downButton = createButton('↓', `icon-button vote-button${vote === -1 ? ' active down' : ''}`, 'Downvote this paper', () => {
    mutateState(state => setPaperVote(state, paper, -1))
  })

  const saved = app.state.saved?.[paper.id] && !app.state.saved[paper.id].deleted
  const saveButton = createButton(saved ? '★' : '☆', `icon-button save-button${saved ? ' active' : ''}`, saved ? 'Remove from saved papers' : 'Save this paper', () => {
    if (saved) {
      mutateState(state => unsavePaper(state, paper.id), { autoSave: false })
    } else {
      mutateState(state => savePaper(state, paper))
    }
  })

  actions.append(upButton, downButton, saveButton)

  const link = document.createElement('a')
  link.className = 'paper-title'
  link.href = paper.url
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = paper.title
  link.title = paper.title

  row.append(actions, link)
  if (options.priority) {
    row.classList.add('priority-paper')
  }
  return row
}

function renderPaperSection(containerId, title, papers, options = {}) {
  const container = document.getElementById(containerId)
  container.replaceChildren()

  const heading = document.createElement('div')
  heading.className = 'section-heading'
  const titleElement = document.createElement('h2')
  titleElement.textContent = title
  const count = document.createElement('span')
  count.className = 'count-badge'
  count.textContent = String(papers.length)
  heading.append(titleElement, count)
  container.append(heading)

  const list = document.createElement('div')
  list.className = 'paper-list'
  if (!papers.length) {
    const empty = document.createElement('p')
    empty.className = 'empty-message'
    empty.textContent = options.emptyMessage || 'Nothing here today.'
    list.append(empty)
  } else {
    for (const paper of papers) {
      list.append(renderPaperRow(paper, options))
    }
  }
  container.append(list)
}

function renderPapersTab() {
  const sections = partitionAndRankPapers(app.paperData.papers, app.state)
  renderPaperSection('priority-section', 'Priority authors', sections.priority, {
    priority: true,
    emptyMessage: 'No priority-author papers in this release.'
  })
  renderPaperSection('papers-section', 'Papers', sections.papers, {
    emptyMessage: 'No primary submissions in this release.'
  })
  renderPaperSection('cross-section', 'Cross-listings', sections.cross, {
    emptyMessage: 'No cross-listings in this release.'
  })

  document.getElementById('papers-tab-count').textContent = String(app.paperData.papers.length)
}

function renderSavedTab() {
  const container = document.getElementById('saved-list')
  container.replaceChildren()
  const saved = activeSavedPapers(app.state)
  document.getElementById('saved-tab-count').textContent = String(saved.length)

  if (!saved.length) {
    const empty = document.createElement('p')
    empty.className = 'empty-message saved-empty'
    empty.textContent = 'No saved papers yet.'
    container.append(empty)
    return
  }

  for (const record of saved) {
    const row = document.createElement('article')
    row.className = 'paper-row saved-row'

    const actions = document.createElement('div')
    actions.className = 'paper-actions'
    const removeButton = createButton('×', 'icon-button remove-button', 'Remove from saved papers', () => {
      mutateState(state => unsavePaper(state, record.id), { autoSave: false })
    })
    actions.append(removeButton)

    const link = document.createElement('a')
    link.className = 'paper-title'
    link.href = record.url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = record.title
    link.title = record.title

    row.append(actions, link)
    container.append(row)
  }
}

function renderPriorityAuthors() {
  const list = document.getElementById('priority-author-list')
  list.replaceChildren()
  for (const entry of app.state.priority_authors) {
    const chip = document.createElement('span')
    chip.className = 'author-chip'
    const name = document.createElement('span')
    name.textContent = entry.name
    const remove = createButton('×', 'chip-remove', `Remove ${entry.name}`, () => {
      const next = app.state.priority_authors.filter(author => normalizeName(author.name) !== normalizeName(entry.name))
      mutateState(state => setPriorityAuthors(state, next))
    })
    chip.append(name, remove)
    list.append(chip)
  }
}

function renderLearnedWeights() {
  const authorContainer = document.getElementById('learned-authors')
  const topicContainer = document.getElementById('learned-topics')
  authorContainer.replaceChildren()
  topicContainer.replaceChildren()

  const renderEntries = (container, entries, emptyText) => {
    if (!entries.length) {
      const empty = document.createElement('span')
      empty.className = 'muted'
      empty.textContent = emptyText
      container.append(empty)
      return
    }
    for (const [name, weight] of entries) {
      const item = document.createElement('span')
      item.className = Number(weight) >= 0 ? 'weight-chip positive' : 'weight-chip negative'
      item.textContent = `${name} ${Number(weight) >= 0 ? '+' : ''}${Number(weight).toFixed(1)}`
      container.append(item)
    }
  }

  renderEntries(authorContainer, topModelEntries(app.state.model.authors, 12), 'No author preferences learned yet.')
  renderEntries(topicContainer, topModelEntries(app.state.model.topics, 16), 'No topic preferences learned yet.')
}

function renderSyncSettings() {
  const endpointInput = document.getElementById('sync-endpoint')
  const keyInput = document.getElementById('sync-key')
  if (document.activeElement !== endpointInput) {
    endpointInput.value = app.syncSettings.endpoint || app.config?.sync?.default_endpoint || ''
  }
  if (document.activeElement !== keyInput) {
    keyInput.value = app.syncSettings.key || ''
  }

  if (!stateEndpoint()) {
    setSyncStatus('Saved on this browser', 'warning')
  } else if (!app.syncSettings.key) {
    setSyncStatus('Sync key needed', 'warning')
  } else if (app.meta.dirty) {
    setSyncStatus('Changes waiting to sync', 'warning')
  } else {
    setSyncStatus('Synced to GitHub', 'success')
  }
}

function renderTabs() {
  const knownTabs = ['papers', 'saved', 'authors']
  if (!knownTabs.includes(app.activeTab)) {
    app.activeTab = 'papers'
  }
  for (const tab of knownTabs) {
    const button = document.querySelector(`[data-tab-button="${tab}"]`)
    const panel = document.getElementById(`${tab}-tab`)
    const active = tab === app.activeTab
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', String(active))
    panel.hidden = !active
  }
}

function renderHeader() {
  const releaseDate = app.paperData.release_date || 'Latest release'
  document.getElementById('release-date').textContent = releaseDate
  const sampleBanner = document.getElementById('sample-banner')
  sampleBanner.hidden = !app.paperData.sample
  document.title = `Paper feed · ${releaseDate}`
}

function render() {
  renderHeader()
  renderPapersTab()
  renderSavedTab()
  renderPriorityAuthors()
  renderLearnedWeights()
  renderSyncSettings()
  renderTabs()
}

function setActiveTab(tab) {
  app.activeTab = tab
  history.replaceState(null, '', tab === 'papers' ? location.pathname : `#${tab}`)
  renderTabs()
}

function exportState() {
  const blob = new Blob([`${JSON.stringify(app.state, null, 2)}\n`], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `paper-feed-state-${new Date().toISOString().slice(0, 10)}.json`
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(link.href)
}

async function importState(file) {
  const text = await file.text()
  const imported = ensureStateShape(JSON.parse(text), app.seedState.priority_authors)
  app.state = mergeStates(app.state, imported, app.seedState.priority_authors)
  markDirty()
  render()
  scheduleSync(50)
}

function attachEventHandlers() {
  document.querySelectorAll('[data-tab-button]').forEach(button => {
    button.addEventListener('click', () => setActiveTab(button.dataset.tabButton))
  })

  document.getElementById('priority-author-form').addEventListener('submit', event => {
    event.preventDefault()
    const input = document.getElementById('priority-author-input')
    const name = input.value.trim()
    if (!name) {
      return
    }
    const exists = app.state.priority_authors.some(entry => normalizeName(entry.name) === normalizeName(name))
    if (!exists) {
      mutateState(state => setPriorityAuthors(state, [...state.priority_authors, { name, aliases: [] }]))
    }
    input.value = ''
  })

  document.getElementById('save-sync-settings').addEventListener('click', async () => {
    app.syncSettings.endpoint = document.getElementById('sync-endpoint').value.trim()
    app.syncSettings.key = document.getElementById('sync-key').value
    persistSyncSettings()
    renderSyncSettings()
    if (stateEndpoint()) {
      try {
        const remote = await loadRemoteState()
        if (remote) {
          app.state = mergeStates(app.state, remote, app.seedState.priority_authors)
          app.state = autoSavePriorityPapers(app.state, app.paperData.papers)
          markDirty()
        }
        await syncState()
      } catch (error) {
        console.error(error)
        setSyncStatus('Could not connect', 'error')
      }
    }
  })

  document.getElementById('sync-now').addEventListener('click', async () => {
    if (!app.meta.dirty) {
      try {
        const remote = await loadRemoteState()
        if (remote) {
          const merged = mergeStates(app.state, remote, app.seedState.priority_authors)
          const beforeAutoSave = stateFingerprint(merged)
          app.state = merged
          app.state = autoSavePriorityPapers(app.state, app.paperData.papers)
          if (stateFingerprint(app.state) !== beforeAutoSave) {
            markDirty()
            scheduleSync(50)
          } else {
            persistLocalState()
          }
          render()
        }
      } catch (error) {
        console.error(error)
        setSyncStatus('Could not connect', 'error')
      }
    } else {
      await syncState().catch(error => {
        console.error(error)
        setSyncStatus('Could not sync', 'error')
      })
    }
  })

  document.getElementById('export-state').addEventListener('click', exportState)
  document.getElementById('import-state').addEventListener('change', async event => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }
    try {
      await importState(file)
    } catch (error) {
      console.error(error)
      alert('That file is not a valid paper-feed state file.')
    } finally {
      event.target.value = ''
    }
  })

  window.addEventListener('online', () => scheduleSync(50))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && app.meta.dirty) {
      syncState().catch(() => {})
    }
  })
}

async function initialize() {
  try {
    const [config, paperData, seedState] = await Promise.all([
      fetchJson('./config.json'),
      fetchJson('./data/papers.json'),
      fetchJson('./data/state.json')
    ])

    app.config = config
    app.paperData = paperData
    app.seedState = ensureStateShape(seedState, seedState.priority_authors || [])
    app.meta = parseJsonStorage(STORAGE_KEYS.meta, { dirty: false })
    app.syncSettings = parseJsonStorage(STORAGE_KEYS.sync, {
      endpoint: config.sync?.default_endpoint || '',
      key: ''
    })

    const localState = parseJsonStorage(STORAGE_KEYS.state, null)
    app.state = localState
      ? mergeStates(app.seedState, localState, app.seedState.priority_authors)
      : ensureStateShape(app.seedState, app.seedState.priority_authors)

    const beforeAutoSave = stateFingerprint(app.state)
    app.state = autoSavePriorityPapers(app.state, paperData.papers)
    if (stateFingerprint(app.state) !== beforeAutoSave) {
      app.meta.dirty = true
    }

    const hashTab = location.hash.replace('#', '')
    app.activeTab = ['papers', 'saved', 'authors'].includes(hashTab) ? hashTab : 'papers'

    attachEventHandlers()
    persistLocalState()
    render()
    document.getElementById('app-loading').hidden = true

    if (stateEndpoint()) {
      try {
        setSyncStatus('Loading GitHub state', 'working')
        const remoteState = await loadRemoteState()
        if (remoteState) {
          const beforeMerge = stateFingerprint(app.state)
          app.state = mergeStates(app.state, remoteState, app.seedState.priority_authors)
          app.state = autoSavePriorityPapers(app.state, paperData.papers)
          if (stateFingerprint(app.state) !== beforeMerge) {
            app.meta.dirty = true
          }
          persistLocalState()
          render()
        }
        if (app.meta.dirty) {
          scheduleSync(100)
        }
      } catch (error) {
        console.error(error)
        setSyncStatus('Saved on this browser', 'warning')
      }
    }
  } catch (error) {
    console.error(error)
    document.getElementById('app-error').hidden = false
    document.getElementById('app-loading').hidden = true
  }
}

initialize()
