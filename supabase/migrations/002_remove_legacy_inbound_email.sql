-- Removes the forwarding-email field from projects that already ran migration 001.
-- The current workflow uses Gmail API, Microsoft Graph, or direct PDF upload.
alter table public.profiles
  drop column if exists inbound_email_alias;
