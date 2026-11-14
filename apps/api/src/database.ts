import pg from 'pg';

export function openDatabase(environment = process.env, max = 10) {
  const connection = environment.DATABASE_URL
    ? { connectionString: environment.DATABASE_URL }
    : {
        host: environment.PGHOST ?? '127.0.0.1',
        port: Number(environment.PGPORT ?? environment.POSTGRES_PORT ?? 5433),
        database: environment.PGDATABASE ?? 'afisha',
        user: environment.PGUSER ?? 'afisha',
        password: environment.PGPASSWORD ?? environment.POSTGRES_PASSWORD,
      };
  const pool = new pg.Pool({ ...connection, max, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.warn('An idle PostgreSQL connection ended. New requests open a new connection.'));
  return pool;
}

export function siteOrigin(environment = process.env) {
  const url = new URL(environment.PUBLIC_SITE_URL || `http://localhost:${environment.WEB_PORT || 3000}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_SITE_URL must be a site origin.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('PUBLIC_SITE_URL must use HTTPS outside localhost.');
  }
  return url.origin;
}
