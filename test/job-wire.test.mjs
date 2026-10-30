/**
 * `job/registered` + `job/settled` live-frame mapping (`buildWireEvent`).
 *
 * Why this test exists: history ships the raw `JobRegisteredData` / `JobSettledData`,
 * but the live event frame used to fall through to the default branch and keep only
 * `type`. A live-only view therefore had no tool duration, and could not pair a
 * `jobId` with its `toolCall.callId` until the job *settled* — it had to guess from a
 * shell tool's kickoff text. Both types now mirror the history field names.
 *
 * The fixture follows DSH's own declaration (verified against the desktop build):
 *   JobRegisteredData { jobId, owner, kind, label, startedAt, toolCall?{callId,rootCallId} }
 *   JobSettledData extends it { finishedAt, status, cause, producerReported, detail? }
 */
import assert from 'node:assert/strict'
import { buildWireEvent } from '../lib/index.mjs'

const session = { id: 'session-job-1' }

// ── 1. full settled job: every history field we care about survives ──────────────
const full = {
  type: 'job/settled',
  seq: 42,
  time: 1_786_937_352_000,
  data: {
    jobId: 'job-1',
    owner: 'session-job-1',
    kind: 'tool',
    label: 'npm test (workspace: dsh-bot-webui)',
    startedAt: 1_786_937_300_000,
    finishedAt: 1_786_937_352_000,
    status: 'completed',
    cause: 'producer',
    producerReported: true,
    detail: 'exit 0',
    toolCall: { callId: 'call-9', rootCallId: 'call-9' },
  },
}

const wire = buildWireEvent(session, full)
assert.deepEqual(wire, {
  kind: 'event',
  sessionId: 'session-job-1',
  seq: 42,
  time: 1_786_937_352_000,
  event: {
    type: 'job/settled',
    jobId: 'job-1',
    kind: 'tool',
    label: 'npm test (workspace: dsh-bot-webui)',
    toolCall: { callId: 'call-9', rootCallId: 'call-9' },
    startedAt: 1_786_937_300_000,
    finishedAt: 1_786_937_352_000,
    status: 'completed',
    cause: 'producer',
    producerReported: true,
    detail: 'exit 0',
  },
})

// the whole point: the live frame alone yields the same duration as history
assert.equal(wire.event.finishedAt - wire.event.startedAt, 52_000)

// `owner` is the session id and already on the frame's root as `sessionId`;
// don't duplicate Host-internal identity inside the event.
assert.equal('owner' in wire.event, false)

// ── 2. minimal settled job: absent optionals are omitted, not sent as undefined ──
const minimal = buildWireEvent(session, {
  type: 'job/settled',
  seq: 43,
  time: 1,
  data: { jobId: 'job-2', kind: 'tool', label: 'bash', startedAt: 10, finishedAt: 15, status: 'failed', cause: 'kill', producerReported: false },
})
assert.equal(minimal.event.type, 'job/settled')
assert.equal(minimal.event.finishedAt - minimal.event.startedAt, 5)
assert.equal('toolCall' in minimal.event, false)
assert.equal('detail' in minimal.event, false)
// `producerReported: false` is the default; sending it would add noise for every frame
assert.equal('producerReported' in minimal.event, false)

// ── 3. defensive: malformed toolCall / wrong field types never throw, never leak ──
const weird = buildWireEvent(session, {
  type: 'job/settled',
  seq: 44,
  time: 1,
  data: { jobId: 42, toolCall: 'nope', label: null, startedAt: '10', status: {}, cause: null },
})
assert.deepEqual(weird.event, { type: 'job/settled' })

// ── 4. additive only: types we do not map still get the old `{type}` shape ───────
//     (`job/registered` used to be asserted here; it now has its own branch, see 6.)
const unknown = buildWireEvent(session, { type: 'goal/change', seq: 46, time: 1, data: { goal: 'x' } })
assert.deepEqual(unknown.event, { type: 'goal/change' })

const unknownJobish = buildWireEvent(session, {
  type: 'job/quarantined',
  seq: 45,
  time: 1,
  data: { jobId: 'job-3', label: 'bash', startedAt: 1 },
})
assert.deepEqual(unknownJobish.event, { type: 'job/quarantined' })

// ── 5. root envelope is untouched (surfaceOp / sourceEventSeqs still pass through) ─
const withEnvelope = buildWireEvent(session, {
  type: 'job/settled',
  seq: 47,
  time: 2,
  surfaceOp: 'replace',
  sourceEventSeqs: [40, 41],
  data: { jobId: 'job-4', startedAt: 1_000, finishedAt: 2_500, status: 'completed' },
})
assert.equal(withEnvelope.surfaceOp, 'replace')
assert.deepEqual(withEnvelope.sourceEventSeqs, [40, 41])
assert.equal(withEnvelope.event.finishedAt - withEnvelope.event.startedAt, 1_500)

// ── 6. job/registered: identity at start, with the same history field names ──────
const registeredFull = buildWireEvent(session, {
  type: 'job/registered',
  seq: 50,
  time: 1_786_937_300_000,
  data: {
    jobId: 'bash-f575020712354509',
    owner: 'session-job-1',
    kind: 'bash',
    label: 'echo k3-job-probe && sleep 2',
    startedAt: 1_786_937_300_000,
    toolCall: { callId: 'call_00_Yy', rootCallId: 'call_00_Yy' },
  },
})
assert.deepEqual(registeredFull.event, {
  type: 'job/registered',
  jobId: 'bash-f575020712354509',
  kind: 'bash',
  label: 'echo k3-job-probe && sleep 2',
  toolCall: { callId: 'call_00_Yy', rootCallId: 'call_00_Yy' },
  startedAt: 1_786_937_300_000,
})
// `owner` is the session id and already on the frame root — same call as job/settled
assert.equal('owner' in registeredFull.event, false)
// a registration has no outcome yet; don't invent one
assert.equal('finishedAt' in registeredFull.event, false)
assert.equal('status' in registeredFull.event, false)

// ── 7. job/registered: minimal event omits absent fields, never sends undefined ──
const registeredMinimal = buildWireEvent(session, {
  type: 'job/registered',
  seq: 51,
  time: 1,
  data: { jobId: 'bash-2' },
})
assert.deepEqual(registeredMinimal.event, { type: 'job/registered', jobId: 'bash-2' })
assert.equal(Object.values(registeredMinimal.event).every((v) => v !== undefined), true)

const registeredEmpty = buildWireEvent(session, { type: 'job/registered', seq: 52, time: 1, data: {} })
assert.deepEqual(registeredEmpty.event, { type: 'job/registered' })

// ── 8. malformed toolCall / wrong field types never throw, never emit junk ───────
const registeredWeird = buildWireEvent(session, {
  type: 'job/registered',
  seq: 53,
  time: 1,
  data: { jobId: 42, kind: null, label: {}, startedAt: '10', toolCall: 'nope' },
})
assert.deepEqual(registeredWeird.event, { type: 'job/registered' })

const registeredNoCallId = buildWireEvent(session, {
  type: 'job/registered',
  seq: 54,
  time: 1,
  data: { jobId: 'bash-3', toolCall: { rootCallId: 'call_root_only' } },
})
assert.deepEqual(registeredNoCallId.event, { type: 'job/registered', jobId: 'bash-3' })

// ── 9. the point of the branch: pair jobId↔callId at start, then use the settled ─
//     frame for the outcome. This is what removes the client's text matching.
const reg = buildWireEvent(session, {
  type: 'job/registered',
  seq: 60,
  time: 1_000,
  data: { jobId: 'bash-9de278c3dca44715', kind: 'bash', label: 'sleep 45', startedAt: 1_000,
    toolCall: { callId: 'call_abc', rootCallId: 'call_abc' } },
})
const set = buildWireEvent(session, {
  type: 'job/settled',
  seq: 61,
  time: 3_000,
  data: { jobId: 'bash-9de278c3dca44715', kind: 'bash', label: 'sleep 45',
    startedAt: 1_000, finishedAt: 3_000, status: 'completed', cause: 'producer',
    producerReported: true, toolCall: { callId: 'call_abc', rootCallId: 'call_abc' } },
})
// same jobId on both frames → a client keys its map on jobId and resolves the call
assert.equal(reg.event.jobId, set.event.jobId)
assert.equal(reg.event.toolCall.callId, 'call_abc')
assert.equal(set.event.toolCall.callId, reg.event.toolCall.callId)
// registration alone gives the start; only settlement gives the duration
assert.equal('finishedAt' in reg.event, false)
assert.equal(set.event.finishedAt - reg.event.startedAt, 2_000)

console.log('JOB WIRE TESTS PASSED')
