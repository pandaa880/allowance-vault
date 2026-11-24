import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SQL lives in `queries.ts` (and the numbered `.sql` migration files) only. This is a source
 * scan, so it is a tripwire for mistakes, not a security boundary. It checks every file in
 * `src/infrastructure/pg` except `queries.ts`, so a new file is covered automatically.
 */
const dir = new URL('../../src/infrastructure/pg/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'queries.ts');

// A string, template or object literal handed straight to query(), with or without generics.
const literalToQuery = /\.query\s*(<[\s\S]*?>)?\s*\(\s*['"`{]/;
// A string literal that starts like a SQL statement.
const sqlLiteral =
  /['"`]\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK)\b/i;

describe('no inline SQL outside queries.ts', () => {
  it('scans the adapter files (so the check cannot pass on an empty list)', () => {
    expect(files).toEqual(expect.arrayContaining(['pg-ledger-repository.ts', 'migrate.ts']));
  });

  for (const file of files) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    it(`${file}: no literal passed to query()`, () => {
      expect(source).not.toMatch(literalToQuery);
    });
    it(`${file}: no SQL-looking string literal`, () => {
      expect(source).not.toMatch(sqlLiteral);
    });
  }

  it('the patterns do catch the bypasses a review found', () => {
    const bypasses = [
      "client.query<{ t: Partial<Record<K, V>> }>('SELECT 1')",
      "client.query({ text: 'SELECT 1' })",
      'client.query(`SELECT 1`)',
      "const sql = 'SELECT 1'; client.query(sql)",
    ];
    const caught = bypasses.map((code) => literalToQuery.test(code) || sqlLiteral.test(code));
    expect(caught).toEqual(bypasses.map(() => true));
  });
});
