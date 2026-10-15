import pg from 'pg';
import { SCHEMA } from './schema.js';
import { ORG_ID, BUILTIN_ROLES } from './permissions.js';
import { ensureGeneral } from './ideas-data.js';

// BIGINT -> Number (all timestamps are epoch milliseconds, well within 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

let impl = null;
let schemaReady = null;

/** Replace the database (tests and local dev use PGlite). */
export function setDb(custom) {
  impl = custom;
  schemaReady = null;
}
/** True when a database was handed in with setDb (tests, local dev, the demo): DATABASE_URL is not needed then. */
export const hasCustomDb = () => impl !== null && !process.env.DATABASE_URL;

function poolDb() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  return {
    async query(text, params) {
      return (await pool.query(text, params)).rows;
    },
    async exec(text) {
      await pool.query(text);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({ query: async (t, p) => (await client.query(t, p)).rows });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

/** Adapter for an in-process PGlite instance. */
export function pgliteDb(pgl) {
  return {
    async query(text, params) {
      return (await pgl.query(text, params)).rows;
    },
    async exec(text) {
      await pgl.exec(text);
    },
    async tx(fn) {
      return pgl.transaction(async (t) => fn({ query: async (q, p) => (await t.query(q, p)).rows }));
    },
  };
}

/**
 * Rows every station needs, after the schema: the organization and the built-in roles (never overwritten, they can be
 * edited from the console). Once only (migration roles-v1): the users that existed before roles all become owners, so
 * nobody loses a power they had.
 */
async function seed(d) {
  const now = Date.now();
  await d.query("insert into orgs (id, name, created_at) values ($1, 'Stazione', $2) on conflict (id) do nothing", [ORG_ID, now]);
  const configuredLimit = Number(process.env.MAX_USERS || 2);
  const initialLimit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 2;
  await d.query("update orgs set settings = settings || $2::jsonb where id = $1 and not settings ? 'userLimit'", [ORG_ID, JSON.stringify({ userLimit: initialLimit })]);
  await d.query("update orgs set settings = settings || '{\"auditRetentionDays\":365}'::jsonb where id = $1 and not settings ? 'auditRetentionDays'", [ORG_ID]);
  for (const r of BUILTIN_ROLES) {
    await d.query(
      `insert into roles (id, org_id, name, builtin, permissions, created_at, updated_at) values ($1, $2, $3, true, $4, $5, $5)
       on conflict (id) do nothing`,
      [r.id, ORG_ID, r.name, JSON.stringify(r.permissions), now],
    );
  }
  await d.tx(async (q) => {
    const [done] = await q.query("insert into migrations (id, applied_at) values ('roles-v1', $1) on conflict (id) do nothing returning id", [now]);
    if (done) await q.query("insert into memberships (user_id, org_id, role_id, updated_at) select id, $1, 'owner', $2 from users on conflict (user_id) do nothing", [ORG_ID, now]);
  });
  await ensureGeneral(d);
  await d.query("update notes set category_id = 'general-org' where category_id is null and room_id is null");
  await d.tx(async q => {
    const [fresh] = await q.query("insert into migrations (id,applied_at) values ('reception-v1',$1) on conflict do nothing returning id", [now]);
    if (fresh) {
      const [existing] = await q.query('select (select count(*) from claudes)::int + (select count(*) from users)::int as n');
      const mode = existing.n ? 'unrestricted' : ['manual','automatic','unrestricted'].includes(process.env.RECEPTION_DEFAULT) ? process.env.RECEPTION_DEFAULT : 'manual';
      await q.query('update orgs set reception_default=$2 where id=$1', [ORG_ID, mode]);
    }
  });
}

/** Tables of team modules (checked in lib/modules.js: only mod_<id>_ names). A failing one is reported, not fatal. */
async function moduleSchemas(d) {
  const { loadModules } = await import('./modules.js');
  for (const { id, sql } of (await loadModules()).schema) {
    try { await d.exec(sql); } catch (err) { console.error(`module ${id}: schema failed: ${err?.message || err}`); }
  }
}

export async function db() {
  if (!impl) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
    impl = poolDb();
  }
  if (!schemaReady) {
    schemaReady = impl.exec(SCHEMA).then(() => seed(impl)).then(() => moduleSchemas(impl)).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  await schemaReady;
  return impl;
}
