import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";

const dsn = process.env.NEON_DATABASE_URL;
if (!dsn) {
  console.error("NEON_DATABASE_URL is required");
  process.exit(1);
}

const migrationsDir = process.env.NEON_MIGRATIONS_DIR
  ? path.resolve(process.env.NEON_MIGRATIONS_DIR)
  : path.resolve(process.cwd(), "../../neon/migrations");

async function listMigrationFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

async function run() {
  const files = await listMigrationFiles(migrationsDir);
  if (files.length === 0) {
    console.log(`no migration files found in ${migrationsDir}`);
    return;
  }

  const pool = new Pool({
    connectionString: dsn,
    ssl: { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists public.schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    await client.query("select pg_advisory_lock(hashtext('brain_dock_schema_migrations'))");

    for (const file of files) {
      const version = path.basename(file, ".sql");
      const existing = await client.query(
        "select 1 from public.schema_migrations where version = $1 limit 1",
        [version],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        console.log(`skip migration: ${version}`);
        continue;
      }

      console.log(`apply migration: ${version}`);
      const sql = await fs.readFile(file, "utf8");
      await client.query(sql);
      await client.query("insert into public.schema_migrations(version) values ($1)", [version]);
    }
  } finally {
    try {
      await client.query("select pg_advisory_unlock(hashtext('brain_dock_schema_migrations'))");
    } catch {
      // no-op
    }
    client.release();
    await pool.end();
  }

  console.log("neon migrations complete");
}

run().catch((error) => {
  console.error("failed to apply migrations");
  console.error(error);
  process.exit(1);
});
