/**
 * `job/settled` live-frame mapping (`buildWireEvent`).
 *
 * Why this test exists: history ships the raw `JobSettledData`, but the live event
 * frame used to fall through to the default branch and keep only `type`, so a
 * live-only view had no tool duration. The mapping now mirrors the history field
 * names (`startedAt` / `finishedAt` / `toolCall.callId` / `label` / `status`), so a
 * client computes the same `finishedAt - startedAt` from either source.
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

// ── 4. additive only: other job types and unknown types keep the old shape ───────
const registered = buildWireEvent(session, {
  type: 'job/registered',
  seq: 45,
  time: 1,
  data: { jobId: 'job-3', label: 'bash', startedAt: 1 },
})
assert.deepEqual(registered.event, { type: 'job/registered' })

const unknown = buildWireEvent(session, { type: 'goal/change', seq: 46, time: 1, data: { goal: 'x' } })
assert.deepEqual(unknown.event, { type: 'goal/change' })

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

console.log('JOB SETTLED WIRE TESTS PASSED')
