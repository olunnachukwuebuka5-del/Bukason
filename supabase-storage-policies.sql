-- Run this in Supabase Dashboard -> SQL Editor
-- Restricts each user to their own folder: attachments/{user_id}/filename

create policy "Users upload own attachments"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users read own attachments"
on storage.objects for select
to authenticated
using (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users delete own attachments"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);
