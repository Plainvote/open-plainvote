import Database from 'better-sqlite3';

/**
 * All SQL lives here. The registrar stores ONLY SHA256(code) — never plaintext
 * codes — plus per-election issuance rows and per-election RSA keypairs.
 *
 * The issuance row also stores the blinded message and the blind signature the
 * registrar returned, enabling idempotent retries: replaying the identical
 * blinded request returns the identical stored signature instead of minting a
 * second credential.
 */

export interface CodeRow {
  codeHash: string;
  status: 'active' | 'revoked';
  createdAt: number;
  revokedAt: number | null;
  replacedBy: string | null;
  /** null = unscoped (legacy single-tenant behaviour) */
  rollId: string | null;
}

export interface ElectionRollRow {
  electionId: string;
  rollId: string;
  boundAt: number;
}

export interface IssuanceRow {
  codeHash: string;
  electionId: string;
  issuedAt: number;
  blindedMsg: string;
  blindSignature: string;
}

export interface ElectionKeysRow {
  electionId: string;
  publicJwk: string;
  privateJwk: string;
  salt: string;
  createdAt: number;
}

export interface ReturnCodeSheetRow {
  sheetId: string;
  electionId: string;
  /** base64url per-sheet secret; never leaves the RCA */
  secret: string;
  createdAt: number;
}

export class RegistrarDb {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS codes (
        codeHash   TEXT PRIMARY KEY,
        status     TEXT NOT NULL CHECK (status IN ('active','revoked')),
        createdAt  INTEGER NOT NULL,
        revokedAt  INTEGER,
        replacedBy TEXT
      );
      CREATE TABLE IF NOT EXISTS issuance (
        codeHash       TEXT NOT NULL,
        electionId     TEXT NOT NULL,
        issuedAt       INTEGER NOT NULL,
        blindedMsg     TEXT NOT NULL,
        blindSignature TEXT NOT NULL,
        PRIMARY KEY (codeHash, electionId)
      );
      CREATE TABLE IF NOT EXISTS electionKeys (
        electionId TEXT PRIMARY KEY,
        publicJwk  TEXT NOT NULL,
        privateJwk TEXT NOT NULL,
        salt       TEXT NOT NULL,
        createdAt  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resets (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        codeHash   TEXT NOT NULL,
        electionId TEXT NOT NULL,
        resetAt    INTEGER NOT NULL
      );
      -- Return-code sheets. Deliberately stores ONLY sheetId -> secret, with NO
      -- link to any codeHash or voter, so the RCA cannot rejoin an anonymous
      -- token to a voter. (See docs/RETURN-CODES.md for the trust model.)
      CREATE TABLE IF NOT EXISTS returnCodeSheets (
        sheetId    TEXT PRIMARY KEY,
        electionId TEXT NOT NULL,
        secret     TEXT NOT NULL,
        createdAt  INTEGER NOT NULL
      );
      -- Which voter roll an election draws its electorate from. Without a row
      -- here an election is UNBOUND: every active code can vote in it, which is
      -- correct for a single-tenant deployment and wrong for a shared one.
      -- See requireRollBinding in the registrar config.
      CREATE TABLE IF NOT EXISTS electionRolls (
        electionId TEXT PRIMARY KEY,
        rollId     TEXT NOT NULL,
        boundAt    INTEGER NOT NULL
      );
    `);
    this.migrate();
  }

  /**
   * Additive migrations for databases created before a column existed.
   * SQLite has no `ADD COLUMN IF NOT EXISTS`, so check the schema first.
   */
  private migrate(): void {
    const columns = this.db.prepare(`PRAGMA table_info(codes)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === 'rollId')) {
      // Existing codes become unscoped, preserving their current behaviour
      // exactly: they keep working for elections that have no roll bound.
      this.db.exec(`ALTER TABLE codes ADD COLUMN rollId TEXT`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_codes_rollId ON codes (rollId)`);
  }

  close(): void {
    this.db.close();
  }

  // -- codes ---------------------------------------------------------------

  insertCode(codeHash: string, createdAt: number, rollId: string | null = null): void {
    this.db
      .prepare(`INSERT INTO codes (codeHash, status, createdAt, rollId) VALUES (?, 'active', ?, ?)`)
      .run(codeHash, createdAt, rollId);
  }

  /** Insert a whole batch atomically — a partial batch would strand codes. */
  insertCodes(codeHashes: readonly string[], createdAt: number, rollId: string | null = null): void {
    const stmt = this.db.prepare(`INSERT INTO codes (codeHash, status, createdAt, rollId) VALUES (?, 'active', ?, ?)`);
    const txn = this.db.transaction(() => {
      for (const codeHash of codeHashes) stmt.run(codeHash, createdAt, rollId);
    });
    txn();
  }

  getCode(codeHash: string): CodeRow | undefined {
    return this.db.prepare(`SELECT * FROM codes WHERE codeHash = ?`).get(codeHash) as CodeRow | undefined;
  }

  listCodes(rollId?: string): (CodeRow & { issuedElections: string[] })[] {
    const codes = (
      rollId === undefined
        ? this.db.prepare(`SELECT * FROM codes ORDER BY createdAt, codeHash`).all()
        : this.db.prepare(`SELECT * FROM codes WHERE rollId = ? ORDER BY createdAt, codeHash`).all(rollId)
    ) as CodeRow[];
    const issuance = this.db.prepare(`SELECT codeHash, electionId FROM issuance`).all() as {
      codeHash: string;
      electionId: string;
    }[];
    const byCode = new Map<string, string[]>();
    for (const row of issuance) {
      const list = byCode.get(row.codeHash);
      if (list) list.push(row.electionId);
      else byCode.set(row.codeHash, [row.electionId]);
    }
    return codes.map((c) => ({ ...c, issuedElections: byCode.get(c.codeHash) ?? [] }));
  }

  revokeCode(codeHash: string, revokedAt: number): boolean {
    const result = this.db
      .prepare(`UPDATE codes SET status = 'revoked', revokedAt = ? WHERE codeHash = ? AND status = 'active'`)
      .run(revokedAt, codeHash);
    return result.changes === 1;
  }

  /**
   * Replace a code atomically: new active code inserted, old code revoked, and
   * all issuance rows TRANSFERRED to the new code hash. Transferring (never
   * resetting) the issued flags is what prevents a regenerated code from
   * obtaining a second credential for an election it already used.
   */
  regenerateCode(oldCodeHash: string, newCodeHash: string, now: number): boolean {
    const txn = this.db.transaction(() => {
      const old = this.getCode(oldCodeHash);
      if (!old || old.status !== 'active') return false;
      // The replacement inherits the roll, or a regenerated code would silently
      // fall out of its own electorate.
      this.db
        .prepare(`INSERT INTO codes (codeHash, status, createdAt, rollId) VALUES (?, 'active', ?, ?)`)
        .run(newCodeHash, now, old.rollId);
      this.db
        .prepare(`UPDATE codes SET status = 'revoked', revokedAt = ?, replacedBy = ? WHERE codeHash = ?`)
        .run(now, newCodeHash, oldCodeHash);
      this.db.prepare(`UPDATE issuance SET codeHash = ? WHERE codeHash = ?`).run(newCodeHash, oldCodeHash);
      return true;
    });
    return txn() as boolean;
  }

  countCodes(): { active: number; revoked: number } {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM codes GROUP BY status`).all() as {
      status: string;
      n: number;
    }[];
    let active = 0;
    let revoked = 0;
    for (const r of rows) {
      if (r.status === 'active') active = r.n;
      if (r.status === 'revoked') revoked = r.n;
    }
    return { active, revoked };
  }

  /** Per-roll code counts. Unscoped codes (rollId NULL) are excluded. */
  countCodesByRoll(): { rollId: string; activeCodes: number; revokedCodes: number }[] {
    const rows = this.db
      .prepare(
        `SELECT rollId, status, COUNT(*) AS n FROM codes
         WHERE rollId IS NOT NULL GROUP BY rollId, status ORDER BY rollId`,
      )
      .all() as { rollId: string; status: string; n: number }[];
    const byRoll = new Map<string, { rollId: string; activeCodes: number; revokedCodes: number }>();
    for (const r of rows) {
      const entry = byRoll.get(r.rollId) ?? { rollId: r.rollId, activeCodes: 0, revokedCodes: 0 };
      if (r.status === 'active') entry.activeCodes = r.n;
      if (r.status === 'revoked') entry.revokedCodes = r.n;
      byRoll.set(r.rollId, entry);
    }
    return [...byRoll.values()];
  }

  // -- election ↔ roll binding ---------------------------------------------

  getElectionRoll(electionId: string): ElectionRollRow | undefined {
    return this.db.prepare(`SELECT * FROM electionRolls WHERE electionId = ?`).get(electionId) as
      | ElectionRollRow
      | undefined;
  }

  /**
   * Bind an election to a roll. Idempotent for the same roll; refuses to
   * re-point an election at a different electorate, which would silently
   * enfranchise or disenfranchise people mid-election.
   */
  bindElectionRoll(electionId: string, rollId: string, now: number): 'bound' | 'unchanged' | 'conflict' {
    const existing = this.getElectionRoll(electionId);
    if (existing) return existing.rollId === rollId ? 'unchanged' : 'conflict';
    this.db
      .prepare(`INSERT INTO electionRolls (electionId, rollId, boundAt) VALUES (?, ?, ?)`)
      .run(electionId, rollId, now);
    return 'bound';
  }

  listElectionRolls(): ElectionRollRow[] {
    return this.db.prepare(`SELECT * FROM electionRolls`).all() as ElectionRollRow[];
  }

  // -- issuance ------------------------------------------------------------

  getIssuance(codeHash: string, electionId: string): IssuanceRow | undefined {
    return this.db
      .prepare(`SELECT * FROM issuance WHERE codeHash = ? AND electionId = ?`)
      .get(codeHash, electionId) as IssuanceRow | undefined;
  }

  /** Throws on (codeHash, electionId) conflict — callers use that as the race arbiter. */
  insertIssuance(row: IssuanceRow): void {
    this.db
      .prepare(
        `INSERT INTO issuance (codeHash, electionId, issuedAt, blindedMsg, blindSignature) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.codeHash, row.electionId, row.issuedAt, row.blindedMsg, row.blindSignature);
  }

  listIssuanceCodeHashes(electionId: string): string[] {
    const rows = this.db
      .prepare(`SELECT codeHash FROM issuance WHERE electionId = ? ORDER BY codeHash`)
      .all(electionId) as { codeHash: string }[];
    return rows.map((r) => r.codeHash);
  }

  countIssuance(electionId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM issuance WHERE electionId = ?`).get(electionId) as {
      n: number;
    };
    return row.n;
  }

  /** Audited support hatch for device loss. Deletes the issuance row and logs the reset. */
  resetIssuance(codeHash: string, electionId: string, now: number): boolean {
    const txn = this.db.transaction(() => {
      const result = this.db
        .prepare(`DELETE FROM issuance WHERE codeHash = ? AND electionId = ?`)
        .run(codeHash, electionId);
      if (result.changes !== 1) return false;
      this.db
        .prepare(`INSERT INTO resets (codeHash, electionId, resetAt) VALUES (?, ?, ?)`)
        .run(codeHash, electionId, now);
      return true;
    });
    return txn() as boolean;
  }

  countResets(electionId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM resets WHERE electionId = ?`).get(electionId) as {
      n: number;
    };
    return row.n;
  }

  // -- election keys -------------------------------------------------------

  getElectionKeys(electionId: string): ElectionKeysRow | undefined {
    return this.db.prepare(`SELECT * FROM electionKeys WHERE electionId = ?`).get(electionId) as
      | ElectionKeysRow
      | undefined;
  }

  insertElectionKeys(row: ElectionKeysRow): void {
    this.db
      .prepare(`INSERT INTO electionKeys (electionId, publicJwk, privateJwk, salt, createdAt) VALUES (?, ?, ?, ?, ?)`)
      .run(row.electionId, row.publicJwk, row.privateJwk, row.salt, row.createdAt);
  }

  listElectionIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT electionId FROM electionKeys
         UNION SELECT electionId FROM issuance
         UNION SELECT electionId FROM resets
         UNION SELECT electionId FROM electionRolls
         ORDER BY electionId`,
      )
      .all() as { electionId: string }[];
    return rows.map((r) => r.electionId);
  }

  // -- return-code sheets --------------------------------------------------

  insertReturnCodeSheet(row: ReturnCodeSheetRow): void {
    this.db
      .prepare(`INSERT INTO returnCodeSheets (sheetId, electionId, secret, createdAt) VALUES (?, ?, ?, ?)`)
      .run(row.sheetId, row.electionId, row.secret, row.createdAt);
  }

  getReturnCodeSheet(sheetId: string): ReturnCodeSheetRow | undefined {
    return this.db.prepare(`SELECT * FROM returnCodeSheets WHERE sheetId = ?`).get(sheetId) as
      | ReturnCodeSheetRow
      | undefined;
  }

  countReturnCodeSheets(electionId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM returnCodeSheets WHERE electionId = ?`).get(electionId) as {
      n: number;
    };
    return row.n;
  }
}
