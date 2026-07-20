import Database from 'better-sqlite3'
import type { Event } from '@lastpub/core'

/**
 * Withholding store (design doc §3.1). WAL, every status transition in its
 * own transaction. No soft delete: cancellation deletes job + wrap for good
 * (§3.5). Deliberately no round column — the round lives in the rumor,
 * which the tower never sees (withholding + privacy, §3.2).
 */

export type JobStatus = 'scheduled' | 'publishing' | 'published'

export type JobRow = {
  id: number
  request_id: string
  author: string
  wrap_json: string
  wrap_id: string
  publish_at: number
  relays_json: string
  status: JobStatus
  attempts: number
  result_event_id: string | null
  created_at: number
  updated_at: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
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
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, publish_at);
CREATE INDEX IF NOT EXISTS idx_jobs_author ON jobs(author);

CREATE TABLE IF NOT EXISTS checkins (
  author TEXT PRIMARY KEY,
  last_created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seen_events (
  event_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
`

export class TowerDb {
  private readonly db: Database.Database

  constructor(path = ':memory:') {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  getJobByRequestId(requestId: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE request_id = ?').get(requestId) as
      | JobRow
      | undefined
  }

  hasAnyJob(author: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM jobs WHERE author = ? LIMIT 1').get(author)
  }

  /**
   * One switch per npub (§3.2): a new job atomically replaces the same
   * author's existing scheduled jobs (implicit cancellation).
   */
  insertJob(args: {
    requestId: string
    author: string
    wrap: Event
    publishAt: number
    relays: string[]
    now: number
  }): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM jobs WHERE author = ? AND status = 'scheduled'")
        .run(args.author)
      this.db
        .prepare(
          `INSERT INTO jobs (request_id, author, wrap_json, wrap_id, publish_at, relays_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
        )
        .run(
          args.requestId,
          args.author,
          JSON.stringify(args.wrap),
          args.wrap.id,
          args.publishAt,
          JSON.stringify(args.relays),
          args.now,
          args.now,
        )
    })
    tx()
  }

  deleteScheduledJob(requestId: string, author: string): boolean {
    const res = this.db
      .prepare("DELETE FROM jobs WHERE request_id = ? AND author = ? AND status = 'scheduled'")
      .run(requestId, author)
    return res.changes > 0
  }

  /** Due jobs: scheduled once past publish_at, plus publishing retries after backoff. */
  dueJobs(now: number, retryDelay: number): JobRow[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE (status = 'scheduled' AND publish_at <= ?)
            OR (status = 'publishing' AND updated_at <= ?)`,
      )
      .all(now, now - retryDelay) as JobRow[]
  }

  markPublishing(id: number, now: number): void {
    this.db
      .prepare(
        "UPDATE jobs SET status = 'publishing', attempts = attempts + 1, updated_at = ? WHERE id = ?",
      )
      .run(now, id)
  }

  markPublished(id: number, resultEventId: string, now: number): void {
    this.db
      .prepare(
        "UPDATE jobs SET status = 'published', result_event_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(resultEventId, now, id)
  }

  lastCheckinAt(author: string): number {
    const row = this.db
      .prepare('SELECT last_created_at FROM checkins WHERE author = ?')
      .get(author) as { last_created_at: number } | undefined
    return row?.last_created_at ?? 0
  }

  hasSeenEvent(eventId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM seen_events WHERE event_id = ?').get(eventId)
  }

  recordCheckin(author: string, createdAt: number, eventId: string, now: number): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO checkins (author, last_created_at) VALUES (?, ?)
           ON CONFLICT(author) DO UPDATE SET last_created_at = excluded.last_created_at`,
        )
        .run(author, createdAt)
      this.db
        .prepare('INSERT OR IGNORE INTO seen_events (event_id, seen_at) VALUES (?, ?)')
        .run(eventId, now)
    })
    tx()
  }

  /** Clean up the replay window (§3.1): 48 h; the monotonicity anchor covers anything older. */
  pruneSeenEvents(now: number, maxAgeSec = 48 * 3600): void {
    this.db.prepare('DELETE FROM seen_events WHERE seen_at < ?').run(now - maxAgeSec)
  }

  close(): void {
    this.db.close()
  }
}
