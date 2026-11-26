/** Shared by the integration tests: where the throwaway test Postgres (docker compose) lives. */
export const databaseUrl: string =
  process.env['DATABASE_URL'] ?? 'postgres://vault:vault@localhost:54329/vault_test';

/** The same server, another database (used to migrate from nothing). */
export const databaseUrlFor = (name: string): string => {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};
