import { describe, expect, it, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TowerDb } from '../src/db.js'

/**
 * Migration path: a DB created before the `slot` column must open cleanly with
 * the current code. This is the case a fresh :memory: DB never exercises, and
 * the one that crash-looped the reference tower on deploy.
 */
describe('TowerDb migration', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('opens a pre-slot DB, adds the column, and keeps existing rows', () => {
    dir = mkdtempSync(join(tmpdir(), 'lastpub-db-'))
    const path = join(dir, 'old.sqlite')

    // Recreate the schema exactly as it was before the slot column, with a row.
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY,
        request_id TEXT UNIQUE NOT NULL,
        author TEXT NOT NULL,
        wrap_json TEXT NOT NULL,
        wrap_id TEXT NOT NULL,
        publish_at INTEGER NOT NULL,
        relays_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        attempts INTEGER NOT NULL DEFAULT 0,
        result_event_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO jobs (request_id, author, wrap_json, wrap_id, publish_at, relays_json, created_at, updated_at)
      VALUES ('req1', 'authorX', '{}', 'wrapX', 100, '[]', 1, 1);
    `)
    legacy.close()

    // Opening with the current code must not throw and must backfill slot=''.
    const db = new TowerDb(path)
    const row = db.getJobByRequestId('req1')
    expect(row?.slot).toBe('')
    expect(row?.author).toBe('authorX')
    db.close()
  })

  it('a fresh DB has the slot column and its index', () => {
    const db = new TowerDb(':memory:')
    db.insertJob({
      requestId: 'r',
      author: 'a',
      slot: 'msg-1',
      wrap: { id: 'w' } as never,
      publishAt: 200,
      relays: [],
      now: 1,
    })
    expect(db.getJobByRequestId('r')?.slot).toBe('msg-1')
    db.close()
  })
})
