import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAuditLine } from 'jey-core'
import { fileLineSink } from '../../src/jey-plugin.ts'

function tempPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jey-audit-'))
  return { dir, path: join(dir, 'diagnostics.jsonl') }
}

test('the sink appends complete lines and nothing else exists beforehand', () => {
  const { dir, path } = tempPath()
  try {
    const sink = fileLineSink({ path, maxFileBytes: 100_000 })
    sink.writeLine('{"a":1}')
    sink.writeLine('{"a":2}')
    assert.equal(readFileSync(path, 'utf8'), '{"a":1}\n{"a":2}\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a full file is moved aside rather than truncated over a reader', () => {
  const { dir, path } = tempPath()
  try {
    const sink = fileLineSink({ path, maxFileBytes: 24 })
    sink.writeLine('{"seed":true}')
    writeFileSync(path, `${'x'.repeat(40)}\n`, 'utf8')
    sink.writeLine('{"next":true}')

    const siblings = readdirSync(dir).filter(f => f !== 'diagnostics.jsonl')
    assert.equal(siblings.length, 1, 'the previous file was renamed, not deleted')
    assert.match(siblings[0] ?? '', /^diagnostics\.jsonl\.\d+\.old$/)
    assert.equal(readFileSync(path, 'utf8'), '{"next":true}\n')
    assert.equal(readFileSync(join(dir, siblings[0] as string), 'utf8').trim(), 'x'.repeat(40))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an external byte count is trusted, so a size cap is not defeated by another writer', () => {
  const { dir, path } = tempPath()
  try {
    const sink = fileLineSink({ path, maxFileBytes: 40 })
    writeFileSync(path, `${'y'.repeat(200)}\n`, 'utf8')
    sink.writeLine('{"one":1}')
    assert.equal(readdirSync(dir).length, 2, 'the pre-existing file should have been rotated first')
    assert.equal(readFileSync(path, 'utf8'), '{"one":1}\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lines written to disk parse back with the same reader the recovery path uses', () => {
  const { dir, path } = tempPath()
  try {
    const sink = fileLineSink({ path, maxFileBytes: 100_000 })
    const record = {
      kind: 'diagnostic' as const, auditId: 'aud_0f8f0a2f-0000-4000-8000-000000000001',
      requestId: 'r1', sessionId: 's1', reason: 'round-trip', at: 1730000000000,
    }
    sink.writeLine(JSON.stringify(record))
    const parsed = parseAuditLine(readFileSync(path, 'utf8').trim())
    assert.deepEqual(parsed, record)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
