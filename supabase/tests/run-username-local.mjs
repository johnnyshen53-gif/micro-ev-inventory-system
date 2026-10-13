// Run with PGLITE_MODULE pointing to a temporary installation; never touches the cloud.
import { readFile } from 'node:fs/promises';
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
  for(const name of ['20261010000000_multiuser_inventory.sql','20261010000001_lock_down_function_permissions.sql','20261010000002_move_sale_privilege_to_private_schema.sql','20261010000003_add_parts_warranties.sql','20261013050201_atomic_inventory_adjustment.sql']) {
    // PGlite has gen_random_uuid built in; pgcrypto itself is not packaged here.
    await db.exec((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  }
  if (process.argv[2]) await db.exec(await readFile(process.argv[2], 'utf8'));
  await db.exec(await readFile(new URL('./username_auth.test.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('./multiuser_inventory.test.sql', import.meta.url), 'utf8'));
} catch (error) {
  console.error(error.message, 'position:', error.position, 'context:', error.where);
  if (error.position) console.error(error.query?.slice(Number(error.position)-150,Number(error.position)+100));
  await db.close();
  process.exit(1);
}
console.log('PASS username schema, privileges, last admin, limiter boundaries and rollback');
await db.close();
