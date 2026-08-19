-- Run this once in Supabase: Project → SQL Editor → New query → paste → Run

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  mode text not null,
  role text not null,
  content text not null,
  created_at timestamptz default now()
);

alter table public.messages enable row level security;

-- Each person can only ever see or write their own messages — nobody
-- can read anyone else's conversations, enforced by the database itself.
create policy "Users can view their own messages"
  on public.messages for select
  using (auth.uid() = user_id);

create policy "Users can insert their own messages"
  on public.messages for insert
  with check (auth.uid() = user_id);

create index if not exists messages_user_mode_idx
  on public.messages (user_id, mode, created_at);
