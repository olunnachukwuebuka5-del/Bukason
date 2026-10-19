-- BUKASON attachments: private bucket + per-user access.
-- Run once in Supabase -> SQL Editor.
--
-- Each logged-in user can upload, read and delete ONLY files inside
-- their own folder (a folder named with their user id). Nobody else
-- can list or open them. The server reads a file through a temporary
-- signed link that expires after 10 minutes, and the app deletes the
-- file right after the answer comes back.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attachments', 'attachments', false, 15728640,
  array['image/png','image/jpeg','image/webp','image/gif','image/heic','image/heif','application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "bukason attachments insert own" on storage.objects;
create policy "bukason attachments insert own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "bukason attachments select own" on storage.objects;
create policy "bukason attachments select own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "bukason attachments delete own" on storage.objects;
create policy "bukason attachments delete own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
