-- Schema gratuito per salvare le spunte condivise su Supabase.
-- Nota: senza login/auth questa configurazione e' adatta a un gioco tra amici:
-- chiunque apra la pagina pubblica puo' inviare modifiche tramite la chiave anon.

create table if not exists public.pub_claims (
  pub_id text primary key,
  player_id text not null check (player_id in ('daniel', 'stefano', 'nicola')),
  claimed_at timestamptz not null default now()
);

create index if not exists pub_claims_player_id_idx
  on public.pub_claims (player_id);

alter table public.pub_claims enable row level security;

drop policy if exists "pub_claims_select_public" on public.pub_claims;
drop policy if exists "pub_claims_insert_public" on public.pub_claims;
drop policy if exists "pub_claims_delete_public" on public.pub_claims;

create policy "pub_claims_select_public"
  on public.pub_claims
  for select
  to anon
  using (true);

create policy "pub_claims_insert_public"
  on public.pub_claims
  for insert
  to anon
  with check (player_id in ('daniel', 'stefano', 'nicola'));

create policy "pub_claims_delete_public"
  on public.pub_claims
  for delete
  to anon
  using (true);
