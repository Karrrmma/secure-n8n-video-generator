create extension if not exists pgcrypto;

create table if not exists public.video_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  user_hash text not null,
  client_request_id uuid not null,
  idea text not null,
  style text,
  prompt text,
  model text not null default 'sora-2',
  size text not null default '720x1280',
  duration_seconds integer not null default 8,
  openai_video_id text unique,
  status text not null default 'queued',
  progress integer not null default 0,
  video_path text,
  error_message text,
  moderation_result jsonb,
  provider_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint video_jobs_status_check check (
    status in ('queued', 'in_progress', 'completed', 'failed', 'blocked')
  ),
  constraint video_jobs_progress_check check (progress between 0 and 100),
  constraint video_jobs_duration_check check (duration_seconds in (4, 8, 12)),
  constraint video_jobs_size_check check (
    size in ('720x1280', '1280x720', '1024x1792', '1792x1024')
  ),
  constraint video_jobs_owner_request_unique unique (owner_id, client_request_id)
);

create index if not exists video_jobs_owner_status_idx
  on public.video_jobs (owner_id, status);

create index if not exists video_jobs_created_at_idx
  on public.video_jobs (created_at);

create index if not exists video_jobs_openai_video_id_idx
  on public.video_jobs (openai_video_id);

create or replace function public.set_video_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_video_jobs_updated_at on public.video_jobs;
create trigger set_video_jobs_updated_at
before update on public.video_jobs
for each row
execute function public.set_video_jobs_updated_at();

alter table public.video_jobs enable row level security;

drop policy if exists "Users can read their own video jobs" on public.video_jobs;
create policy "Users can read their own video jobs"
on public.video_jobs
for select
to authenticated
using (auth.uid()::text = owner_id);

drop policy if exists "Users cannot write video jobs directly" on public.video_jobs;
create policy "Users cannot write video jobs directly"
on public.video_jobs
for all
to authenticated
using (false)
with check (false);

insert into storage.buckets (id, name, public)
values ('generated-videos', 'generated-videos', false)
on conflict (id) do update set public = false;

-- No browser-facing Storage select/insert/update/delete policies are created.
-- n8n uses the Supabase service role key on the server side, and users receive
-- short-lived signed URLs for playback.
