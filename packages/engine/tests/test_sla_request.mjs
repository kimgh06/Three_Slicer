// SLA object-job protocol boundary. These tests deliberately use only the public parser: a worker cannot safely
// turn an object-aware request back into a legacy STL slice without proving that no support/object state is lost.
import { strict as assert } from 'node:assert'
import {
  SlaRequestError,
  parseSlaJob,
  slaFallbackParams,
} from './src/sla_request.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

const stl = new ArrayBuffer(84)
const object = (overrides = {}) => ({ id: 'model-a', stl, ...overrides })
const job = (overrides = {}) => ({ objects: [object()], ...overrides })

// Given: a malformed object job. When: parsing it at the worker boundary. Then: its stable typed error names the
// request problem instead of leaving the worker to fail later in an STL call.
{
  assert.throws(() => parseSlaJob({ objects: [] }), (error) =>
    error instanceof SlaRequestError && error.code === 'SLA_INVALID_REQUEST')
  ok('malformed object job has a typed request error')
}

// Given: Organic is requested. When: parsing the job. Then: it is rejected explicitly; it may never silently use
// the Default strategy.
{
  assert.throws(() => parseSlaJob(job({ support: { strategy: 'organic' } })), (error) =>
    error instanceof SlaRequestError && error.code === 'SLA_UNSUPPORTED_ORGANIC')
  ok('Organic strategy is an explicit capability error')
}

// Given: a request for hollowing. When: parsing the job. Then: it is rejected before a result can be called hollow.
{
  assert.throws(() => parseSlaJob(job({ hollowing: { enabled: true } })), (error) =>
    error instanceof SlaRequestError && error.code === 'SLA_UNSUPPORTED_HOLLOWING')
  ok('hollowing is an explicit capability error')
}

// Given: two ordered object records. When: the JS fallback is selected. Then: it refuses to merge them, because a
// merged STL destroys object identity and any later per-object support ownership.
{
  const parsed = parseSlaJob({ objects: [object(), object({ id: 'model-b' })] })
  assert.throws(() => slaFallbackParams(parsed), (error) =>
    error instanceof SlaRequestError && error.code === 'SLA_FALLBACK_MULTI_OBJECT')
  ok('JS fallback refuses multi-object jobs')
}

// Given: a prepared object carrying a parsed drain hole. When: it crosses the worker request boundary. Then: the
// record is structurally accepted but slicing fails with the explicit hollowing capability error.
{
  assert.throws(() => parseSlaJob(job({ objects: [object({
    drainHoles: [{ position: [1, 2, 3], normal: [0, 0, 1], radius: 0.8, height: 4 }],
  })] })), (error) => error instanceof SlaRequestError && error.code === 'SLA_UNSUPPORTED_HOLLOWING')
  ok('prepared drain holes have an explicit unsupported capability error')
}

// Given: imported point subtypes. When: they cross the worker request boundary. Then: island/slope identity is
// preserved rather than collapsed into FDM paint or rejected as an unknown automatic point.
{
  const parsed = parseSlaJob(job({ objects: [object({
    supportPoints: [{ type: 'island', position: [1, 2, 3], radius: 0.25 }],
  })] }))
  assert.equal(parsed.objects[0].supportPoints[0].type, 'island')
  ok('SLA point subtype survives the worker protocol')
}

// Given: one object with supports enabled. When: the JS contour fallback is selected. Then: it fails instead of
// producing a contour-only result that silently drops the requested support tree.
{
  const parsed = parseSlaJob(job({ support: { enabled: true } }))
  assert.throws(() => slaFallbackParams(parsed), (error) =>
    error instanceof SlaRequestError && error.code === 'SLA_FALLBACK_SUPPORTS')
  ok('JS fallback refuses support-bearing jobs')
}

// Given: a simple one-object contour job. When: it is adapted to the legacy fallback. Then: only explicitly present
// settings cross the boundary — omission is preserved and no schema default is injected.
{
  const parsed = parseSlaJob(job({ settings: { gamma_correction: 0.8 } }))
  const fallback = slaFallbackParams(parsed)
  assert.equal(fallback.stl, stl)
  assert.deepEqual(fallback.params, { gamma_correction: 0.8 })
  ok('fallback preserves settings omission')
}

console.log(`test_sla_request: ${passed} checks passed`)
