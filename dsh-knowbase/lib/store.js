/**
 * 知识库存储层：node:sqlite + FTS5。
 *
 * 表结构与计划书一致：
 *   collections  知识库
 *   documents    文档
 *   chunks       切块（含 FTS5 全文索引）
 *   jobs         长任务进度
 *   settings     键值设置
 *
 * 向量表在 P2 加入（P1 只做全文索引，检索靠关键词）。
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'

const SCHEMA_VERSION = 1

/**
 * 逐版本迁移。
 *
 * 目前仍是 v1，没有需要迁移的结构变更，所以这里保持空表。
 * 以后任何一次改表结构，把 SCHEMA_VERSION 加 1 并在此登记对应步骤：
 *   MIGRATIONS[2] = (db) => db.exec('ALTER TABLE documents ADD COLUMN foo TEXT')
 * 迁移前会自动 VACUUM INTO 一份 kb.sqlite.bak-时间戳。
 */
const MIGRATIONS = {}

/** 备份文件名用的时间戳：20261117-164200 */
function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  filename      TEXT NOT NULL,
  ext           TEXT NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  sha256        TEXT NOT NULL DEFAULT '',
  page_count    INTEGER,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  error         TEXT,
  source_url    TEXT,
  license       TEXT,
  fetched_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_sha ON documents(collection_id, sha256);

CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  text        TEXT NOT NULL,
  page        INTEGER,
  heading     TEXT,
  tokens      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize="trigram"
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT 'running',
  done       INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL DEFAULT 0,
  detail     TEXT NOT NULL DEFAULT '',
  error      TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 向量：每条切块在某个模型下的一条向量记录。
-- 同一 chunk 可以有多个模型的行（换模型后重建期间新旧并存），
-- 检索时只取与当前模型一致的那一批。
CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id   INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  model_id   TEXT NOT NULL,
  dimension  INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  text_hash  TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model_id);
`

export class KnowledgeStore {
  /**
   * @param {string} dataRoot 数据根目录
   */
  constructor(dataRoot) {
    this.dataRoot = dataRoot
    this.filesDir = join(dataRoot, 'files')
    this.db = null
  }

  async open() {
    await mkdir(this.filesDir, { recursive: true })
    this.db = new DatabaseSync(join(this.dataRoot, 'kb.sqlite'))
    this.db.exec(SCHEMA)

    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')

    if (row === undefined) {
      // 全新库：直接记录当前版本
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
      this.migratedFrom = null
      return this
    }

    const from = Number(row.value)
    if (!Number.isFinite(from) || from > SCHEMA_VERSION) {
      // 比当前版本还新：可能是降级安装，不动数据，但要提醒
      this.migratedFrom = { from, to: SCHEMA_VERSION, backup: null, downgrade: true }
      return this
    }

    if (from < SCHEMA_VERSION) {
      /*
       * 结构要变：先备份再迁移。
       * 备份用 VACUUM INTO，产出的是完整一致的单文件（比复制 sqlite+wal 安全）。
       */
      const backupPath = join(this.dataRoot, `kb.sqlite.bak-${formatStamp(new Date())}`)
      try {
        this.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
      } catch (error) {
        // 备份失败就不迁移，宁可停下也不能在没备份的情况下改结构
        throw new Error(
          `升级前自动备份失败，已中止迁移以保护数据：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const applied = []
      for (let version = from + 1; version <= SCHEMA_VERSION; version++) {
        const step = MIGRATIONS[version]
        if (typeof step === 'function') {
          step(this.db)
          applied.push(version)
        }
      }

      this.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version')
      this.migratedFrom = { from, to: SCHEMA_VERSION, backup: backupPath, steps: applied }
    } else {
      this.migratedFrom = null
    }

    return this
  }

  close() {
    this.db?.close()
    this.db = null
  }

  /* ────────────────────── 知识库 ────────────────────── */

  listCollections() {
    return this.db.prepare(`
      SELECT c.id, c.name, c.description, c.created_at, c.updated_at,
             (SELECT COUNT(*) FROM documents d WHERE d.collection_id = c.id) AS document_count,
             (SELECT COALESCE(SUM(d.chunk_count), 0) FROM documents d WHERE d.collection_id = c.id) AS chunk_count,
             (SELECT COALESCE(SUM(d.size), 0) FROM documents d WHERE d.collection_id = c.id) AS bytes,
             (SELECT COALESCE(MAX(d.updated_at), c.updated_at) FROM documents d WHERE d.collection_id = c.id) AS last_activity
      FROM collections c
      ORDER BY c.created_at ASC
    `).all()
  }

  createCollection(name, description = '') {
    const now = Date.now()
    const info = this.db
      .prepare('INSERT INTO collections (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(name, description, now, now)
    return this.getCollection(Number(info.lastInsertRowid))
  }

  getCollection(id) {
    return this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id)
  }

  renameCollection(id, name) {
    this.db.prepare('UPDATE collections SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id)
  }

  deleteCollection(id) {
    this.db.prepare('DELETE FROM collections WHERE id = ?').run(id)
  }

  ensureDefaultCollection() {
    const existing = this.listCollections()
    if (existing.length > 0) return existing[0]
    return this.createCollection('默认知识库', '首次启动自动创建')
  }

  /* ────────────────────── 文档 ────────────────────── */

  listDocuments(collectionId) {
    return this.db.prepare(`
      SELECT id, collection_id, title, filename, ext, size, page_count, chunk_count,
             status, error, source_url, license, created_at
      FROM documents
      WHERE collection_id = ?
      ORDER BY created_at DESC
    `).all(collectionId)
  }

  getDocument(id) {
    return this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id)
  }

  findDocumentByHash(collectionId, sha256) {
    return this.db.prepare('SELECT * FROM documents WHERE collection_id = ? AND sha256 = ?').get(collectionId, sha256)
  }

  /**
   * 统计仍引用同一文件副本的文档数（跨库共享判断）。
   * 文件副本按 sha256+ext 全局共享，删除前必须确认没有其他文档在用。
   */
  countDocumentsByHash(sha256, ext, excludeId = null) {
    const normalized = String(ext ?? '').replace(/^\./, '')
    if (excludeId === null) {
      const row = this.db.prepare(
        "SELECT COUNT(*) AS n FROM documents WHERE sha256 = ? AND REPLACE(ext, '.', '') = ?",
      ).get(sha256, normalized)
      return row?.n ?? 0
    }
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM documents WHERE sha256 = ? AND REPLACE(ext, '.', '') = ? AND id != ?",
    ).get(sha256, normalized, excludeId)
    return row?.n ?? 0
  }

  createDocument({ collectionId, title, filename, ext, size, sha256 }) {
    const now = Date.now()
    const info = this.db.prepare(`
      INSERT INTO documents (collection_id, title, filename, ext, size, sha256, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(collectionId, title, filename, ext, size, sha256, now, now)
    return Number(info.lastInsertRowid)
  }

  updateDocumentStatus(id, status, { error = null, pageCount = null, chunkCount = null } = {}) {
    this.db.prepare(`
      UPDATE documents
      SET status = ?, error = ?, page_count = COALESCE(?, page_count),
          chunk_count = COALESCE(?, chunk_count), updated_at = ?
      WHERE id = ?
    `).run(status, error, pageCount, chunkCount, Date.now(), id)
  }

  /** 记录文档的来源与抓取时间（抓来的资料必须可追溯） */
  setDocumentSource(id, { sourceUrl, license = null, fetchedAt = Date.now() }) {
    this.db.prepare(`
      UPDATE documents
      SET source_url = ?, license = COALESCE(?, license), fetched_at = ?, updated_at = ?
      WHERE id = ?
    `).run(sourceUrl, license, fetchedAt, Date.now(), id)
  }

  deleteDocument(id) {
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  }

  /** 用切块替换某文档的全部内容（事务） */
  replaceChunks(documentId, chunks) {
    const db = this.db
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId)
      const insert = db.prepare('INSERT INTO chunks (document_id, ord, text, page, heading, tokens) VALUES (?, ?, ?, ?, ?, ?)')
      for (const chunk of chunks) {
        insert.run(documentId, chunk.ord, chunk.text, chunk.page ?? null, chunk.heading ?? null, chunk.tokens ?? 0)
      }
      db.prepare('UPDATE documents SET chunk_count = ?, updated_at = ? WHERE id = ?').run(chunks.length, Date.now(), documentId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  listChunks(documentId, limit = 200) {
    return this.db.prepare(
      'SELECT id, ord, text, page, heading, tokens FROM chunks WHERE document_id = ? ORDER BY ord LIMIT ?',
    ).all(documentId, limit)
  }

  /* ────────────────────── 全文检索（P1 基础版）────────────────────── */

  /**
   * 全文检索。
   *
   * 中文用 trigram 分词器（unicode61 不切中文，整段会被当成一个词）。
   * trigram 只索引 3 字以上的序列，所以两字词（如「数电」）会漏；
   * 这种情况退回 LIKE 子串匹配。两层结果合并去重后返回。
   */
  search(query, { collectionId = null, limit = 10 } = {}) {
    const cleaned = String(query ?? '').trim()
    if (!cleaned) return []

    const filter = collectionId === null ? '' : 'AND d.collection_id = ?'
    const filterArgs = collectionId === null ? [] : [collectionId]
    const results = new Map()

    // 第一层：FTS5 trigram（3 字及以上有效）
    if (cleaned.length >= 3) {
      const phrase = `"${cleaned.replace(/"/g, '""')}"`
      try {
        const rows = this.db.prepare(`
          SELECT ch.id, ch.text, ch.page, ch.heading, ch.ord,
                 d.id AS document_id, d.title, d.filename, d.collection_id,
                 bm25(chunks_fts) AS score
          FROM chunks_fts
          JOIN chunks ch ON ch.id = chunks_fts.rowid
          JOIN documents d ON d.id = ch.document_id
          WHERE chunks_fts MATCH ? ${filter}
          ORDER BY score
          LIMIT ?
        `).all(phrase, ...filterArgs, limit)
        for (const row of rows) results.set(row.id, row)
      } catch {
        // FTS 语法异常时跳过，走 LIKE 兜底
      }
    }

    // 第二层：LIKE 兜底（覆盖两字词与 FTS 未命中的情况）
    if (results.size < limit) {
      try {
        const rows = this.db.prepare(`
          SELECT ch.id, ch.text, ch.page, ch.heading, ch.ord,
                 d.id AS document_id, d.title, d.filename, d.collection_id,
                 NULL AS score
          FROM chunks ch
          JOIN documents d ON d.id = ch.document_id
          WHERE ch.text LIKE ? ${filter}
          ORDER BY ch.document_id, ch.ord
          LIMIT ?
        `).all(`%${cleaned}%`, ...filterArgs, limit)
        for (const row of rows) {
          if (!results.has(row.id)) results.set(row.id, row)
        }
      } catch {
        // 忽略
      }
    }

    return [...results.values()].slice(0, limit)
  }

  /* ────────────────────── 文件副本 ────────────────────── */

  hashOf(buffer) {
    return createHash('sha256').update(buffer).digest('hex')
  }

  filePath(sha256, ext) {
    return join(this.filesDir, `${sha256}${ext.startsWith('.') ? ext : `.${ext}`}`)
  }

  async saveFile(sha256, ext, buffer) {
    const target = this.filePath(sha256, ext)
    await writeFile(target, buffer)
    return target
  }

  async readFile(sha256, ext) {
    return readFile(this.filePath(sha256, ext))
  }

  async removeFile(sha256, ext) {
    try {
      await unlink(this.filePath(sha256, ext))
    } catch {
      // 文件不存在时忽略
    }
  }

  /* ────────────────────── 任务 ────────────────────── */

  createJob(id, kind, label, total = 0) {
    this.db.prepare(
      'INSERT INTO jobs (id, kind, label, state, done, total, started_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    ).run(id, kind, label, 'running', total, Date.now())
  }

  updateJob(id, { done = null, total = null, detail = null, state = null, error = null }) {
    this.db.prepare(`
      UPDATE jobs SET
        done  = COALESCE(?, done),
        total = COALESCE(?, total),
        detail = COALESCE(?, detail),
        state = COALESCE(?, state),
        error = COALESCE(?, error),
        ended_at = CASE WHEN ? IN ('done', 'failed') THEN ? ELSE ended_at END
      WHERE id = ?
    `).run(done, total, detail, state, error, state, Date.now(), id)
  }

  getJob(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
  }

  recentJobs(limit = 20) {
    return this.db.prepare('SELECT * FROM jobs ORDER BY started_at DESC LIMIT ?').all(limit)
  }

  /* ────────────────────── 向量 ────────────────────── */

  /** 写入一批向量（事务）。rows: { chunkId, dimension, vec: Buffer, textHash } */
  saveEmbeddings(modelId, rows) {
    if (rows.length === 0) return
    const db = this.db
    db.exec('BEGIN')
    try {
      const stmt = db.prepare(`
        INSERT INTO embeddings (chunk_id, model_id, dimension, vec, text_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_id, model_id) DO UPDATE SET
          dimension = excluded.dimension,
          vec = excluded.vec,
          text_hash = excluded.text_hash,
          created_at = excluded.created_at
      `)
      const now = Date.now()
      for (const row of rows) {
        stmt.run(row.chunkId, modelId, row.dimension, row.vec, row.textHash ?? '', now)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /** 某知识库下、属于指定模型的所有向量（带切块与文档信息） */
  listVectors(collectionId, modelId) {
    const args = [modelId]
    let filter = ''
    if (collectionId !== null) {
      filter = 'AND d.collection_id = ?'
      args.push(collectionId)
    }
    return this.db.prepare(`
      SELECT e.chunk_id, e.vec, e.dimension, e.text_hash,
             ch.text, ch.page, ch.heading, ch.ord AS chunk_ord,
             d.id AS document_id, d.title, d.collection_id
      FROM embeddings e
      JOIN chunks ch ON ch.id = e.chunk_id
      JOIN documents d ON d.id = ch.document_id
      WHERE e.model_id = ? ${filter}
    `).all(...args)
  }

  /** 统计某模型已建向量的切块数 */
  countEmbeddings(modelId, collectionId = null) {
    const args = [modelId]
    let filter = ''
    if (collectionId !== null) {
      filter = 'AND d.collection_id = ?'
      args.push(collectionId)
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n
      FROM embeddings e
      JOIN chunks ch ON ch.id = e.chunk_id
      JOIN documents d ON d.id = ch.document_id
      WHERE e.model_id = ? ${filter}
    `).get(...args)
    return row?.n ?? 0
  }

  /** 统计某库的切块总数（用于判断向量覆盖是否完整） */
  countChunks(collectionId = null) {
    if (collectionId === null) {
      return this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get()?.n ?? 0
    }
    return this.db.prepare(`
      SELECT COUNT(*) AS n
      FROM chunks ch JOIN documents d ON d.id = ch.document_id
      WHERE d.collection_id = ?
    `).get(collectionId)?.n ?? 0
  }

  /** 取出待建向量的切块（按模型过滤掉已建的） */
  chunksNeedingEmbedding(modelId, collectionId = null, limit = 500) {
    const args = [modelId]
    let filter = ''
    if (collectionId !== null) {
      filter = 'AND d.collection_id = ?'
      args.push(collectionId)
    }
    args.push(limit)
    return this.db.prepare(`
      SELECT ch.id AS chunk_id, ch.text, ch.ord
      FROM chunks ch
      JOIN documents d ON d.id = ch.document_id
      LEFT JOIN embeddings e ON e.chunk_id = ch.id AND e.model_id = ?
      WHERE e.chunk_id IS NULL ${filter}
      ORDER BY ch.id
      LIMIT ?
    `).all(...args)
  }

  /** 删除某模型下的全部向量（重建前调用） */
  clearEmbeddings(modelId, collectionId = null) {
    if (collectionId === null) {
      this.db.prepare('DELETE FROM embeddings WHERE model_id = ?').run(modelId)
      return
    }
    this.db.prepare(`
      DELETE FROM embeddings
      WHERE model_id = ? AND chunk_id IN (
        SELECT ch.id FROM chunks ch
        JOIN documents d ON d.id = ch.document_id
        WHERE d.collection_id = ?
      )
    `).run(modelId, collectionId)
  }

  /** 清理切块已删除的孤立向量 */
  pruneEmbeddings() {
    this.db.prepare(`
      DELETE FROM embeddings
      WHERE chunk_id NOT IN (SELECT id FROM chunks)
    `).run()
  }

  /* ────────────────────── 设置 ────────────────────── */

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    if (!row) return fallback
    try {
      return JSON.parse(row.value)
    } catch {
      return row.value
    }
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(value))
  }

  deleteSetting(key) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  /* ────────────────────── 统计 ────────────────────── */

  counts() {
    return this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM collections) AS collections,
        (SELECT COUNT(*) FROM documents)   AS documents,
        (SELECT COUNT(*) FROM chunks)      AS chunks
    `).get()
  }
}

/** 从文件名推断标题（去掉扩展名与路径） */
export function titleFromFilename(filename) {
  const base = basename(filename)
  const ext = extname(base)
  return base.slice(0, base.length - ext.length) || base
}
