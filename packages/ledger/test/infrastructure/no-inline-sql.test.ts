import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SQL lives in two places only: `src/infrastructure/pg/queries.ts` for what the application
 * runs (plus the numbered `.sql` migrations), and `test/support/sql.ts` for test-only inspection
 * and attacks. Everything else, source and tests alike, refers to those constants. This is a
 * source scan, so it is a tripwire for mistakes, not a security boundary. New files are covered
 * automatically.
 */
const packageRoot = new URL('../../', import.meta.url);
const ALLOWED = new Set([
  'src/infrastructure/pg/queries.ts',
  'test/support/sql.ts',
  'test/infrastructure/no-inline-sql.test.ts', // holds the bypass samples below
]);

const tsFilesUnder = (dir: string): string[] =>
  readdirSync(new URL(dir, packageRoot), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `${dir}${file}`);

const files = [...tsFilesUnder('src/'), ...tsFilesUnder('test/')].filter((f) => !ALLOWED.has(f));

// A string, template or object literal handed straight to query(), with or without generics.
const literalToQuery = /\.query\s*(<[\s\S]*?>)?\s*\(\s*['"`{]/;
// A string literal that starts like a SQL statement.
const sqlLiteral =
  /['"`]\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|BEGIN|COMMIT|ROLLBACK|SET|RESET)\b/i;

describe('no inline SQL outside queries.ts and test/support/sql.ts', () => {
  it('scans source and test files (so the check cannot pass on an empty list)', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'src/infrastructure/pg/pg-ledger-repository.ts',
        'src/infrastructure/pg/migrate.ts',
        'test/integration/ledger.test.ts',
        'test/support/raw.ts',
      ]),
    );
  });

  describe.each(files)('%s', (file) => {
    const source = readFileSync(new URL(file, packageRoot), 'utf8');
    it('passes no literal to query()', () => {
      expect(source).not.toMatch(literalToQuery);
    });
    it('has no SQL-looking string literal', () => {
      expect(source).not.toMatch(sqlLiteral);
    });
  });

  it('the patterns do catch the bypasses a review found', () => {
    const bypasses = [
      "client.query<{ t: Partial<Record<K, V>> }>('SELECT 1')",
      "client.query({ text: 'SELECT 1' })",
      'client.query(`SELECT 1`)',
      "const sql = 'SELECT 1'; client.query(sql)",
      "await client.query('BEGIN')",
    ];
    const caught = bypasses.map((code) => literalToQuery.test(code) || sqlLiteral.test(code));
    expect(caught).toEqual(bypasses.map(() => true));
  });
});
