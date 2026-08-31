/**
 * diff-review host half: observes write/edit tool executions and serves the
 * modification-review payloads over plain HTTP routes for the browser UI.
 * Records are bucketed by the owning agent/session so each session reviews
 * only its own changes. Loaded as a static row in the web profile composition.
 *
 * Revert support: every op records the full before/after file content that the
 * write/edit tool reports, so the UI can either undo ONE specific op (keeping
 * later, non-overlapping changes via a 3-way line merge) or revert the WHOLE
 * file (restore the pre-session snapshot, or delete a file created in-session).
 */
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const MAX_CHARS = 120000
const MAX_OPS = 100
const MAX_LINES = 1500
const MAX_MERGE_LINES = 2000

const name = 'diff-review'
const inject = ['webServer', 'agents']

function cap(s) {
  if (typeof s !== 'string') s = s == null ? '' : String(s)
  return s.slice(0, MAX_CHARS)
}

function splitLines(s) {
  if (s === '') return []
  return s.split('\n')
}

/** Simple LCS line diff -> [{ type: 'ctx'|'del'|'add', a, b, text }] */
function diffLines(a, b) {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const eq = a[i] === b[j]
      dp[i * w + j] = eq
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const out = []
  let pending = []
  function flush() {
    for (const h of pending) out.push(h)
    pending = []
  }
  let i = 0
  let j = 0
  let aNo = 1
  let bNo = 1
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pending.push({ type: 'ctx', a: aNo, b: bNo, text: a[i] })
      i++; j++; aNo++; bNo++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      flush()
      out.push({ type: 'del', a: aNo, b: null, text: a[i] })
      i++; aNo++
    } else {
      flush()
      out.push({ type: 'add', a: null, b: bNo, text: b[j] })
      j++; bNo++
    }
  }
  flush()
  while (i < n) { out.push({ type: 'del', a: aNo, b: null, text: a[i] }); i++; aNo++ }
  while (j < m) { out.push({ type: 'add', a: null, b: bNo, text: b[j] }); j++; bNo++ }
  return out
}

/**
 * Line diff returning hunks [{a0,a1,b0,b1}]: lines a[a0..a1) are replaced by
 * b[b0..b1). Consecutive del/add runs are grouped into a single hunk.
 */
function diffHunks(a, b) {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w
    const next = (i + 1) * w
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j] ? dp[next + j + 1] + 1 : Math.max(dp[next + j], dp[row + j + 1])
    }
  }
  const hunks = []
  let i = 0
  let j = 0
  let a0 = -1
  let a1 = -1
  let b0 = -1
  let b1 = -1
  const close = () => {
    if (a0 >= 0) hunks.push({ a0, a1, b0, b1 })
    a0 = -1
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      close(); i++; j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      if (a0 < 0) { a0 = i; b0 = j }
      a1 = i + 1
      b1 = j
      i++
    } else {
      if (a0 < 0) { a0 = i; b0 = j }
      a1 = i
      b1 = j + 1
      j++
    }
  }
  close()
  if (i < n) {
    const prev = hunks[hunks.length - 1]
    if (prev && prev.a1 === i && prev.b1 === m) prev.a1 = n
    else hunks.push({ a0: i, a1: n, b0: m, b1: m })
  } else if (j < m) {
    const prev = hunks[hunks.length - 1]
    if (prev && prev.a1 === n && prev.b1 === j) prev.b1 = m
    else hunks.push({ a0: n, a1: n, b0: j, b1: m })
  }
  return hunks
}

/**
 * 3-way line merge: start from `base`, keep `ours`' changes, apply
 * `theirs`' changes. Throws when both touch the same base lines.
 */
function merge3(base, ours, theirs) {
  const ho = diffHunks(base, ours)
  const ht = diffHunks(base, theirs)
  for (const o of ho) {
    for (const t of ht) {
      if (o.a0 < t.a1 && t.a0 < o.a1) {
        throw new Error('该项修改与之后的修改有重叠，无法单独撤回；可尝试撤回整个文件，或从最后一项开始逐项撤回')
      }
    }
  }
  const items = []
  for (const h of ho) items.push({ h, src: ours })
  for (const h of ht) items.push({ h, src: theirs })
  items.sort((x, y) => x.h.a0 - y.h.a0)
  const out = []
  let pos = 0
  for (const it of items) {
    const h = it.h
    for (let k = pos; k < h.a0; k++) out.push(base[k])
    for (let k = h.b0; k < h.b1; k++) out.push(it.src[k])
    pos = h.a1
  }
  for (let k = pos; k < base.length; k++) out.push(base[k])
  return out
}

/** Collect a JSON request body (capped at 1MB). */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let tooBig = false
    req.on('data', (chunk) => {
      if (tooBig) return
      data += chunk
      if (data.length > 1e6) {
        tooBig = true
        reject(new Error('请求体过大'))
      }
    })
    req.on('end', () => {
      if (tooBig) return
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch (e) {
        reject(new Error('请求体不是有效的 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Restore a file: null content deletes it (was created in-session), string rewrites it. */
async function applyRestore(absPath, content) {
  if (content === null) {
    try {
      await unlink(absPath)
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) throw e
    }
  } else {
    await writeFile(absPath, content, 'utf8')
  }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

// ── persistence: review records survive dsh web restarts ──────────────
// State lives next to the profile config (ctx.baseUrl), e.g.
// ~/.dsh/profiles/web/diff-review-state.json; fall back to ~/.dsh.
const STATE_FILE_NAME = 'diff-review-state.json'

function stateFilePath(ctx) {
  try {
    if (ctx && ctx.baseUrl) return fileURLToPath(new URL(STATE_FILE_NAME, ctx.baseUrl))
  } catch (e) {}
  return join(homedir(), '.dsh', STATE_FILE_NAME)
}

function serializeSessions(sessions) {
  const out = { version: 1, savedAt: Date.now(), sessions: {} }
  for (const [sid, files] of sessions) {
    if (!files || files.size === 0) continue
    const fileOut = {}
    for (const [path, rec] of files) {
      if (!rec || !Array.isArray(rec.ops) || rec.ops.length === 0) continue
      fileOut[path] = { path: rec.path, cwd: rec.cwd, ops: rec.ops }
    }
    if (Object.keys(fileOut).length > 0) out.sessions[sid] = { files: fileOut }
  }
  return out
}

function loadSessions(sessions, file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    return
  }
  try {
    const data = JSON.parse(raw)
    if (!data || data.version !== 1 || !data.sessions || typeof data.sessions !== 'object') return
    for (const [sid, s] of Object.entries(data.sessions)) {
      if (!s || !s.files || typeof s.files !== 'object') continue
      const files = new Map()
      for (const [path, rec] of Object.entries(s.files)) {
        if (!rec || !Array.isArray(rec.ops)) continue
        const ops = rec.ops.filter((op) => op && (op.kind === 'edit' || op.kind === 'write'))
        if (ops.length === 0) continue
        files.set(path, { path: rec.path || path, cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined, ops })
      }
      if (files.size > 0) sessions.set(sid, files)
    }
  } catch (e) {
    // corrupt state file: ignore and start fresh
  }
}

function persistState(sessions, file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFile(file, JSON.stringify(serializeSessions(sessions)), 'utf8').catch(() => {})
  } catch (e) {}
}

function flushStateSync(sessions, file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(serializeSessions(sessions)), 'utf8')
  } catch (e) {}
}

function apply(ctx) {
  // agent/session id -> path -> { path, cwd, ops }
  const sessions = new Map()
  const clients = new Set()
  // Persistence: load any previous process's records and keep them written so
  // the review survives dsh web restarts.
  const stateFile = stateFilePath(ctx)
  loadSessions(sessions, stateFile)
  let saveTimer = null
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      persistState(sessions, stateFile)
    }, 800)
  }
  ctx.effect(() => () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    flushStateSync(sessions, stateFile)
  }, 'diff-review: persist flush')
  // session id -> { turn, scanSeq }; ops are tagged with the ROOT session's
  // current turn so the client can show per-turn reviews. The turn is derived
  // by scanning the session log tail (position-cached), which is self-consistent
  // and covers resumed sessions whose restored turn/start events never dispatch.
  const turnCursor = new Map()
  function currentTurnOf(rootId) {
    let cur = turnCursor.get(rootId)
    if (!cur) {
      cur = { turn: null, scanSeq: 0 }
      turnCursor.set(rootId, cur)
    }
    try {
      const entry = ctx.agents && ctx.agents.store && ctx.agents.store.get(rootId)
      const session = entry && entry.agent && entry.agent.session
      const events = session && session.events
      if (events && Array.isArray(events) && events.length > cur.scanSeq) {
        const from = cur.scanSeq
        cur.scanSeq = events.length
        for (let i = events.length - 1; i >= from; i--) {
          const e = events[i]
          if (e.type === 'turn/start') { cur.turn = e.data && e.data.turn; break }
          if (e.type === 'turn/end') { cur.turn = null; break }
        }
      }
    } catch (e) {}
    return cur.turn === null ? 0 : cur.turn
  }

  function filesOf(agentId) {
    let files = sessions.get(agentId)
    if (!files) { files = new Map(); sessions.set(agentId, files) }
    return files
  }

  function broadcast(agentId) {
    const payload = 'data: ' + JSON.stringify({ session: agentId }) + '\n\n'
    for (const res of clients) {
      try { res.write(payload) } catch (e) { clients.delete(res) }
    }
  }

  // Walk the live owner chain up to the root session so subagent changes
  // aggregate into the top-level parent session the user views.
  function resolveRootId(agentId) {
    const store = ctx.agents && ctx.agents.store
    if (!store) return agentId
    let current = store.get(agentId)
    if (!current) return agentId
    const seen = new Set()
    while (current.owner) {
      const oid = current.owner.id
      if (!oid || seen.has(oid)) break
      seen.add(oid)
      const next = store.get(oid)
      if (!next) break
      current = next
    }
    return current.agent ? current.agent.id : agentId
  }

  ctx.on('tools/result', (exec, result) => {
    try {
      if (!exec) return
      const toolName = exec.tool || exec.name
      if (toolName !== 'write' && toolName !== 'edit') return
      const input = exec.input || exec.arguments || exec.args
      if (!input || typeof input !== 'object') return
      const file = input.file_path || input.file || input.path
      if (!file) return
      const agentId = exec.agent && exec.agent.id
      if (!agentId) return
      const failed = result && (result.isError || result.error || result.ok === false || result.failed)
      if (failed) return
      const rootId = resolveRootId(agentId)
      const at = Date.now()
      const turn = currentTurnOf(rootId)
      const files = filesOf(rootId)
      let rec = files.get(file)
      if (!rec) {
        const cwd = exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
        rec = { path: file, cwd, ops: [] }
        files.set(file, rec)
      }
      if (rec.ops.length >= MAX_OPS) rec.ops.shift()
      // The write/edit success payload carries the full before/after content,
      // which is exactly what revert needs. before === null -> file created.
      const value = result && !result.isError && result.value && typeof result.value === 'object' ? result.value : null
      const hasBefore = value !== null && 'before' in value
      const hasAfter = value !== null && 'after' in value
      const before = hasBefore ? (value.before === null ? null : cap(value.before)) : undefined
      const after = hasAfter ? cap(value.after) : undefined
      if (toolName === 'edit') {
        rec.ops.push({ kind: 'edit', at, turn, before, after, oldString: cap(input.old_string), newString: cap(input.new_string) })
      } else {
        rec.ops.push({ kind: 'write', at, turn, before, after, content: cap(input.content) })
      }
      broadcast(rootId)
      scheduleSave()
    } catch (e) {
      console.error('diff-review track failed', e)
    }
  })

  function buildSummary(files) {
    const items = []
    for (const rec of files.values()) {
      let added = 0
      let removed = 0
      let writes = 0
      let edits = 0
      for (const op of rec.ops) {
        if (op.kind === 'edit') {
          edits++
          added += splitLines(op.newString).length
          removed += splitLines(op.oldString).length
        } else {
          writes++
          added += splitLines(op.content).length
        }
      }
      const last = rec.ops[rec.ops.length - 1]
      items.push({
        path: rec.path,
        name: String(rec.path).split('/').pop(),
        cwd: rec.cwd,
        ops: rec.ops.length,
        writes,
        edits,
        added,
        removed,
        lastTime: last ? last.at : 0
      })
    }
    items.sort((x, y) => y.lastTime - x.lastTime)
    let latestTurn = 0
    for (const rec of files.values()) {
      for (const op of rec.ops) {
        if (typeof op.turn === 'number' && op.turn > latestTurn) latestTurn = op.turn
      }
    }
    return { files: items, latestTurn }
  }

  // Build one section per op; 'indices' selects which ops (opIndex is the index
  // into the FULL ops array so /diff-review/revert stays valid).
  function buildSections(ops, indices) {
    const sections = []
    for (const i of indices) {
      const op = ops[i]
      let section
      if (op.kind === 'edit') {
        let oldL = splitLines(op.oldString)
        let newL = splitLines(op.newString)
        let truncated = false
        if (oldL.length > MAX_LINES || newL.length > MAX_LINES) {
          truncated = true
          oldL = oldL.slice(0, MAX_LINES)
          newL = newL.slice(0, MAX_LINES)
        }
        let hunks
        if (op.oldString === '') hunks = newL.map((t, k) => ({ type: 'add', a: null, b: k + 1, text: t }))
        else if (op.newString === '') hunks = oldL.map((t, k) => ({ type: 'del', a: k + 1, b: null, text: t }))
        else hunks = diffLines(oldL, newL)
        section = { kind: 'edit', at: op.at, hunks, truncated }
      } else {
        const all = splitLines(op.content)
        let lines = all
        let truncated = false
        if (all.length > MAX_LINES) { truncated = true; lines = all.slice(0, MAX_LINES) }
        section = {
          kind: 'write', at: op.at, wholeFile: true, truncated,
          hunks: lines.map((t, k) => ({ type: 'add', a: null, b: k + 1, text: t }))
        }
      }
      const revertible = op.before !== undefined && op.after !== undefined
      section.opIndex = i
      section.revertible = revertible
      section.canUndo = revertible && (op.before !== null || i === ops.length - 1)
      sections.push(section)
    }
    return sections
  }

  function statsOf(ops) {
    let added = 0
    let removed = 0
    let writes = 0
    let edits = 0
    for (const op of ops) {
      if (op.kind === 'edit') {
        edits++
        added += splitLines(op.newString).length
        removed += splitLines(op.oldString).length
      } else {
        writes++
        added += splitLines(op.content).length
      }
    }
    return { added, removed, writes, edits }
  }

  function buildDetail(files, file) {
    const rec = files.get(file)
    if (!rec) return { path: file, sections: [] }
    const ops = rec.ops
    const first = ops[0]
    return {
      path: file,
      sections: buildSections(ops, ops.map((_, i) => i)),
      revertible: !!(first && first.before !== undefined)
    }
  }

  // Per-turn payload: files with at least one op tagged to 'turn', with only
  // that turn's ops in the sections (opIndex still indexes the full ops array).
  function buildTurn(files, turn) {
    const items = []
    for (const rec of files.values()) {
      const indices = []
      for (let i = 0; i < rec.ops.length; i++) {
        if (rec.ops[i].turn === turn) indices.push(i)
      }
      if (indices.length === 0) continue
      const ops = indices.map((i) => rec.ops[i])
      const stats = statsOf(ops)
      const last = ops[ops.length - 1]
      items.push({
        path: rec.path,
        name: String(rec.path).split('/').pop(),
        cwd: rec.cwd,
        ops: ops.length,
        writes: stats.writes,
        edits: stats.edits,
        added: stats.added,
        removed: stats.removed,
        lastTime: last ? last.at : 0,
        revertible: !!(rec.ops[0] && rec.ops[0].before !== undefined),
        sections: buildSections(rec.ops, indices)
      })
    }
    items.sort((x, y) => y.lastTime - x.lastTime)
    return { turn, files: items }
  }

  function queryParam(req, key) {
    return new URL(req.url, 'http://localhost').searchParams.get(key) || ''
  }

  async function handleRevert(req, res) {
    try {
      const u = new URL(req.url, 'http://localhost')
      const agentId = u.searchParams.get('session') || ''
      const files = sessions.get(agentId)
      const body = await readJsonBody(req)
      const path = body && typeof body.path === 'string' ? body.path : ''
      const opArg = body && body.op !== undefined && body.op !== null ? body.op : null
      if (!files || !files.has(path)) {
        return sendJson(res, 400, { ok: false, error: '未找到该文件的修改记录' })
      }
      const rec = files.get(path)
      const absPath = resolvePath(rec.cwd || process.cwd(), path)
      if (opArg === null) {
        // Whole-file revert: restore the state before the first recorded op.
        const first = rec.ops[0]
        if (!first) return sendJson(res, 400, { ok: false, error: '该文件没有可撤回的修改' })
        if (first.before === undefined) {
          return sendJson(res, 400, { ok: false, error: '该文件的首次修改未记录修改前内容（升级前产生的记录），无法撤回' })
        }
        await applyRestore(absPath, first.before)
        files.delete(path)
        broadcast(agentId)
        scheduleSave()
        return sendJson(res, 200, {
          ok: true, mode: 'file',
          message: first.before === null ? '已删除本次会话中新建的文件' : '已撤回该文件的全部修改'
        })
      }
      const op = Number(opArg)
      if (!Number.isInteger(op) || op < 0 || op >= rec.ops.length) {
        return sendJson(res, 400, { ok: false, error: '修改项索引无效' })
      }
      const target = rec.ops[op]
      if (target.before === undefined || target.after === undefined) {
        return sendJson(res, 400, { ok: false, error: '该项修改未记录内容快照（升级前产生的记录），无法撤回' })
      }
      if (op === rec.ops.length - 1) {
        // Undo the last op: exact snapshot restore (or delete a created file).
        await applyRestore(absPath, target.before)
      } else {
        // Undo a middle op: 3-way merge of current content with the op's inverse.
        if (target.before === null) {
          return sendJson(res, 400, { ok: false, error: '该项修改新建了文件且之后还有修改，无法单独撤回' })
        }
        const base = splitLines(target.after)
        const ours = splitLines(await readFile(absPath, 'utf8'))
        const theirs = splitLines(target.before)
        if (base.length > MAX_MERGE_LINES || ours.length > MAX_MERGE_LINES || theirs.length > MAX_MERGE_LINES) {
          return sendJson(res, 400, { ok: false, error: '文件过大，无法单独撤回该项' })
        }
        await writeFile(absPath, merge3(base, ours, theirs).join('\n'), 'utf8')
      }
      // The reverted op and everything after it no longer represent pending changes.
      rec.ops = rec.ops.slice(0, op)
      if (rec.ops.length === 0) files.delete(path)
      broadcast(agentId)
      scheduleSave()
      return sendJson(res, 200, { ok: true, mode: 'op', message: '已撤回该项修改（其后无冲突的修改已保留）' })
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String((e && e.message) || e) })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/events',
    handler: (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write('retry: 3000\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
    }
  }), 'diff-review: events route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/summary',
    handler: (req, res) => {
      const session = queryParam(req, 'session')
      let files = sessions.get(session)
      if (!files) {
        const rootId = resolveRootId(session)
        if (rootId !== session) files = sessions.get(rootId)
      }
      sendJson(res, 200, buildSummary(files || new Map()))
    }
  }), 'diff-review: summary route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/file',
    handler: (req, res) => {
      const u = new URL(req.url, 'http://localhost')
      const files = sessions.get(u.searchParams.get('session') || '')
      sendJson(res, 200, buildDetail(files || new Map(), u.searchParams.get('path') || ''))
    }
  }), 'diff-review: file route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/turn',
    handler: (req, res) => {
      const u = new URL(req.url, 'http://localhost')
      const session = u.searchParams.get('session') || ''
      let files = sessions.get(session)
      if (!files) {
        const rootId = resolveRootId(session)
        if (rootId !== session) files = sessions.get(rootId)
      }
      const turn = Number(u.searchParams.get('turn'))
      sendJson(res, 200, buildTurn(files || new Map(), Number.isFinite(turn) ? turn : -1))
    }
  }), 'diff-review: turn route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/clear',
    handler: (req, res) => {
      const agentId = queryParam(req, 'session')
      sessions.delete(agentId)
      broadcast(agentId)
      scheduleSave()
      sendJson(res, 200, { ok: true })
    }
  }), 'diff-review: clear route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/revert',
    handler: handleRevert
  }), 'diff-review: revert route')

  // ── vendor static files (diff2html) ──────────────────────────────────
  const vendorDir = join(dirname(fileURLToPath(import.meta.url)), 'vendor')
  function serveVendorFile(fileName, req, res) {
    try {
      if (!fileName || fileName.includes('..')) {
        res.statusCode = 400; res.end('bad path'); return
      }
      const filePath = join(vendorDir, fileName)
      if (!existsSync(filePath)) { res.statusCode = 404; res.end('not found: ' + fileName); return }
      const ext = fileName.slice(fileName.lastIndexOf('.'))
      const mime = MIME[ext] || 'application/octet-stream'
      const content = readFileSync(filePath)
      res.statusCode = 200
      res.setHeader('Content-Type', mime)
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.end(content)
    } catch (e) {
      res.statusCode = 500; res.end(String(e))
    }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-diff-review/vendor/diff2html.min.js',
    handler: (req, res) => serveVendorFile('diff2html.min.js', req, res)
  }), 'diff-review: vendor js')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-diff-review/vendor/diff2html-ui.min.js',
    handler: (req, res) => serveVendorFile('diff2html-ui.min.js', req, res)
  }), 'diff-review: vendor ui js')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-diff-review/vendor/diff2html.min.css',
    handler: (req, res) => serveVendorFile('diff2html.min.css', req, res)
  }), 'diff-review: vendor css')
}
// ── MIME types for static files ──────────────────────────────────────
const MIME = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}

export { apply, cap, diffHunks, diffLines, inject, loadSessions, merge3, name, serializeSessions, splitLines, stateFilePath }