// Host API route proxy: a whitelisted in-process call into exact Fetch routes that
// other host plugins registered on the shared /api channel. Closed by default.
import assert from 'node:assert/strict'
import { createDshHostAdapter } from '../lib/dsh-host-adapter.mjs'
import { handleQuery } from '../lib/index.mjs'
import { createTestPeer } from './helpers/peer.mjs'

const peer = createTestPeer()
const ROUTE = '/api/bot'

/** A connection whose shared handler records what it was given and answers `answer`. */
function createConnection({ answer = () => ({ ok: true, value: { revision: 7 } }) } = {}) {
  const seen = []
  return {
    seen,
    createSharedFetchHandler(channel) {
      assert.equal(channel, '/api')
      return {
        requestBodyMode: () => 'buffered',
        async fetch(request, gotPeer) {
          const url = new URL(request.url)
          seen.push({
            method: request.method,
            pathname: url.pathname,
            contentType: request.headers.get('content-type'),
            body: await request.text(),
            peer: gotPeer,
          })
          const result = answer(url.pathname)
          if (result instanceof Response) return result
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      }
    },
  }
}

const gateway = { async invoke() { throw new Error('typert must not be used by the Host API proxy') }, async stream() { throw new Error('typert must not be used') } }

// 1. Closed by default: an empty whitelist means the feature is absent.
{
  const connection = createConnection()
  const api = createDshHostAdapter(gateway, peer, connection)
  assert.equal(api.hostApi.available(), false)
  assert.deepEqual(api.hostApi.paths, [])
  await assert.rejects(api.hostApi.call(ROUTE, { endpoint: 'state' }), /not enabled/)
  await assert.rejects(api.hostApi.call(ROUTE, {}), error => error.code === 'host-api-unavailable')
  assert.equal(connection.seen.length, 0)
}

// 2. A host without the connection service does not offer the feature even with a whitelist.
{
  const api = createDshHostAdapter(gateway, peer, {}, { hostApiPaths: [ROUTE] })
  assert.equal(api.hostApi.available(), false)
  await assert.rejects(api.hostApi.call(ROUTE, {}), error => error.code === 'host-api-unavailable')
}

// 3. Only whitelisted paths pass, and nothing reaches the host for the others.
{
  const connection = createConnection()
  const api = createDshHostAdapter(gateway, peer, connection, { hostApiPaths: [ROUTE] })
  assert.equal(api.hostApi.available(), true)
  assert.deepEqual(api.hostApi.paths, [ROUTE])
  await assert.rejects(api.hostApi.call('/api/secrets', {}), error => error.code === 'host-api-path-denied')
  assert.equal(connection.seen.length, 0)
}

// 4. The whitelisted call is one POST with the JSON body, through the owner Peer.
{
  const connection = createConnection()
  const api = createDshHostAdapter(gateway, peer, connection, { hostApiPaths: [ROUTE] })
  const result = await api.hostApi.call(ROUTE, { endpoint: 'state', payload: { since: 7 } })
  assert.deepEqual(result, { ok: true, value: { revision: 7 } })
  assert.equal(connection.seen.length, 1)
  const [call] = connection.seen
  assert.equal(call.method, 'POST')
  assert.equal(call.pathname, ROUTE)
  assert.equal(call.contentType, 'application/json')
  assert.deepEqual(JSON.parse(call.body), { endpoint: 'state', payload: { since: 7 } })
  assert.equal(call.peer, peer, 'the owner Peer must be the one the Host admits')
}

// 5. An empty body still sends valid JSON, so the route's own parser never sees an empty stream.
{
  const connection = createConnection()
  const api = createDshHostAdapter(gateway, peer, connection, { hostApiPaths: [ROUTE] })
  await api.hostApi.call(ROUTE, undefined)
  assert.deepEqual(JSON.parse(connection.seen[0].body), {})
}

// 6. HTTP failures (route absent, a non-owner Peer refused, a plugin that crashed) surface
//    as host-api-failed instead of a half-read envelope.
for (const status of [403, 404, 500]) {
  const connection = createConnection({
    answer: () => new Response('nope', { status }),
  })
  const api = createDshHostAdapter(gateway, peer, connection, { hostApiPaths: [ROUTE] })
  await assert.rejects(api.hostApi.call(ROUTE, {}), error => error.code === 'host-api-failed')
}

// 7. A semantic failure inside the envelope is data, not a transport error: the route answers
//    HTTP 200 with ok:false (ds-bot does this for bot/read-only and bot/not-found).
{
  const connection = createConnection({
    answer: () => ({ ok: false, error: { code: 'bot/read-only', message: 'Another dsh host holds the team' } }),
  })
  const api = createDshHostAdapter(gateway, peer, connection, { hostApiPaths: [ROUTE] })
  assert.deepEqual(await api.hostApi.call(ROUTE, { endpoint: 'state' }), {
    ok: false,
    error: { code: 'bot/read-only', message: 'Another dsh host holds the team' },
  })
}

// 8. The `host-api` query op is a thin pass-through: same pathname, same body, same envelope.
{
  const connection = createConnection()
  const api = createDshHostAdapter(gateway, peer, connection, { hostApiPaths: [ROUTE] })
  const answer = await handleQuery(api, null, null, {
    type: 'host-api',
    pathname: ROUTE,
    body: { endpoint: 'state' },
    requestId: 'req-1',
  }, null)
  assert.deepEqual(answer, {
    kind: 'host-api',
    pathname: ROUTE,
    result: { ok: true, value: { revision: 7 } },
    requestId: 'req-1',
  })

  const denied = await handleQuery(api, null, null, { type: 'host-api', pathname: '/api/other' }, null)
  assert.equal(denied.kind, 'error')
  assert.equal(denied.code, 'host-api-path-denied')
  assert.equal(denied.requestType, 'host-api')
}

// 9. The capability bit is absent while the whitelist is empty, which is what the client
//    probes before offering any Bot surface.
{
  const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8'))
  assert.match(source, /hostApi\.available\(\) \? \['host-api-proxy-v1'\] : \[\]/)
  assert.match(source, /hostApiPaths: Schema\.array\(Schema\.string\(\)\)\.default\(\[\]\)/)
  // The earlier decision stands: no generic typert API proxy, no api.events mux.
  assert.doesNotMatch(source, /apiProxy|api\.events\.mux|api\.respond\s*\(/)
}

console.log('host-api-proxy: 9 groups passed')
