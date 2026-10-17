// Local PGlite test only; never connects to Supabase.
import { readFile, readdir } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE);
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);
  create table auth.sessions(id uuid primary key,user_id uuid references auth.users);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid(),auth.jwt() to authenticated;
`);
try {
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  for (const name of files) {
    const sql = (await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'))
      .replace('create extension if not exists pgcrypto;', '');
    await db.exec(sql);
  }
  await db.exec(await readFile(new URL('./monthly_salesperson.test.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('./idempotent_checkout.test.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('./warranty_expiry_lock_order.test.sql', import.meta.url), 'utf8'));
  await db.exec(`
    insert into auth.users(id, email) values ('40000000-0000-4000-8000-000000000011', 'warranty-admin@example.invalid');
    update public.profiles set role = 'admin', active = true where id = '40000000-0000-4000-8000-000000000011';
    insert into auth.sessions(id, user_id) values ('40000000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000011');
  `);
  for (const name of ['warranty_serial.test.sql', 'cloud_operations.test.sql']) {
    await db.exec(await readFile(new URL('./' + name, import.meta.url), 'utf8'));
  }
} catch (error) {
  console.error(error.message, 'position:', error.position, 'context:', error.where);
  await db.close();
  process.exit(1);
}
console.log('PASS monthly salesperson SQL tests');
await db.close();
