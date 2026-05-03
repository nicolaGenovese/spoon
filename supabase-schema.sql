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

create table if not exists public.pub_claim_votes (
  pub_id text not null references public.pub_claims(pub_id) on delete cascade,
  voter_id text not null check (voter_id in ('daniel', 'stefano', 'nicola')),
  vote text not null check (vote in ('approve', 'reject')),
  voted_at timestamptz not null default now(),
  primary key (pub_id, voter_id)
);

create index if not exists pub_claim_votes_pub_id_idx
  on public.pub_claim_votes (pub_id);

alter table public.pub_claim_votes enable row level security;

drop policy if exists "pub_claim_votes_select_public" on public.pub_claim_votes;
drop policy if exists "pub_claim_votes_insert_public" on public.pub_claim_votes;
drop policy if exists "pub_claim_votes_update_public" on public.pub_claim_votes;
drop policy if exists "pub_claim_votes_delete_public" on public.pub_claim_votes;

create policy "pub_claim_votes_select_public"
  on public.pub_claim_votes
  for select
  to anon
  using (true);

create policy "pub_claim_votes_insert_public"
  on public.pub_claim_votes
  for insert
  to anon
  with check (
    voter_id in ('daniel', 'stefano', 'nicola')
    and vote in ('approve', 'reject')
    and exists (
      select 1
      from public.pub_claims claim
      where claim.pub_id = pub_claim_votes.pub_id
        and claim.player_id <> pub_claim_votes.voter_id
    )
  );

create policy "pub_claim_votes_update_public"
  on public.pub_claim_votes
  for update
  to anon
  using (true)
  with check (
    voter_id in ('daniel', 'stefano', 'nicola')
    and vote in ('approve', 'reject')
    and exists (
      select 1
      from public.pub_claims claim
      where claim.pub_id = pub_claim_votes.pub_id
        and claim.player_id <> pub_claim_votes.voter_id
    )
  );

create policy "pub_claim_votes_delete_public"
  on public.pub_claim_votes
  for delete
  to anon
  using (true);
