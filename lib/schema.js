// Idempotent schema, applied on cold start. All timestamps are epoch milliseconds.
export const SCHEMA = `
create table if not exists app_meta (id int primary key);
insert into app_meta (id) values (1) on conflict do nothing;

create table if not exists users (
  id text primary key,
  username text not null unique,
  password_hash text not null,
  password_pending_hash text,
  totp_secret_enc text,
  totp_pending_enc text,
  totp_last_step bigint not null default 0,
  recovery_hash text,
  status text not null default 'pending',
  pending_expires_at bigint,
  telegram_chat_id bigint unique,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists sessions (
  id_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  kind text not null,
  attempts int not null default 0,
  created_at bigint not null,
  last_seen bigint not null,
  expires_at bigint not null
);
create index if not exists sessions_user on sessions (user_id);

create table if not exists api_tokens (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  created_at bigint not null,
  last_used_at bigint,
  expires_at bigint not null,
  revoked_at bigint
);

create table if not exists auth_attempts (
  id bigserial primary key,
  key text not null,
  at bigint not null
);
create index if not exists auth_attempts_key on auth_attempts (key, at);

create table if not exists audit_log (
  id bigserial primary key,
  user_id text,
  event text not null,
  detail jsonb,
  ip_hash text,
  at bigint not null
);

create table if not exists telegram_codes (
  code_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  expires_at bigint not null
);

create table if not exists claudes (
  id text primary key,
  owner_id text not null references users(id) on delete cascade,
  name text not null,
  status text not null default 'idle',
  activity text not null default '',
  task_id text,
  project text not null default '',
  joined_at bigint not null,
  last_seen bigint not null,
  inbox_read_at bigint not null default 0
);

create table if not exists tasks (
  id text primary key,
  title text not null,
  detail text not null default '',
  project text not null default '',
  resources jsonb not null default '[]',
  status text not null default 'open',
  owner_claude text,
  created_by text not null,
  note text not null default '',
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists lock_guards (project text primary key);

create table if not exists locks (
  project text not null,
  resource text not null,
  owner_claude text not null,
  reason text not null default '',
  task_id text,
  created_at bigint not null,
  expires_at bigint not null,
  primary key (project, resource)
);

create table if not exists messages (
  id bigserial primary key,
  from_claude text not null,
  to_target text not null,
  text text not null,
  project text not null default '',
  secure_id text,
  created_at bigint not null
);
create index if not exists messages_created on messages (created_at);

create table if not exists secure_items (
  id text primary key,
  message_id bigint,
  from_claude text not null,
  owner_user text not null references users(id) on delete cascade,
  to_target text not null,
  project text not null default '',
  reason text not null default '',
  detected jsonb not null default '[]',
  preview text not null default '',
  ciphertext text,
  status text not null,
  policy text,
  created_at bigint not null,
  approval_expires_at bigint not null,
  decided_at bigint,
  available_until bigint,
  telegram_message_id bigint
);

create table if not exists decisions (
  id bigserial primary key,
  by_claude text not null,
  project text not null default '',
  text text not null,
  created_at bigint not null
);

create table if not exists contexts (
  project text primary key,
  summary text not null,
  updated_by text not null,
  updated_at bigint not null,
  version int not null default 1
);

-- F1: a mission reserved for one Claude (null = anyone can claim it).
alter table tasks add column if not exists assignee text;

-- Drastic actions (deleting files/data, big rewrites) a Claude asks its own human to approve, via Telegram or panel.
create table if not exists asks (
  id text primary key,
  claude_id text not null,
  owner_user text not null references users(id) on delete cascade,
  project text not null default '',
  text text not null,
  status text not null default 'pending',
  telegram_message_id bigint,
  created_at bigint not null,
  expires_at bigint not null,
  decided_at bigint
);
create index if not exists asks_owner_status on asks (owner_user, status);

-- Rooms: one per project, plus the Bridge (management). A session is bound to one room for its whole life.
create table if not exists rooms (
  id text primary key,
  name text not null,
  kind text not null default 'project',
  project text not null,
  keys jsonb not null default '[]',
  created_by text not null,
  created_at bigint not null
);
alter table claudes add column if not exists room text;
alter table claudes add column if not exists host text not null default '';
alter table messages add column if not exists room text;
alter table claudes add column if not exists role text not null default 'general';

-- Recaps: short summaries a Claude writes for the humans of its room, read on the panel instead of every message.
create table if not exists recaps (
  id bigserial primary key,
  project text not null default '',
  room text,
  by_claude text not null,
  title text not null,
  body text not null,
  created_at bigint not null
);
create index if not exists recaps_created on recaps (created_at);
-- Asks are either a permission (yes/no, 30 min) or an opinion (free answer, 24 h).
alter table asks add column if not exists kind text not null default 'permission';
alter table asks add column if not exists answer text;

-- Account avatar: one key from a fixed list drawn by public/js/avatar.js (no uploads).
alter table users add column if not exists avatar text not null default 'astronaut';

-- Ideas board: humans only (never in /api/state, Claude tokens refused).
create table if not exists notes (
  id bigserial primary key,
  user_id text not null references users(id) on delete cascade,
  text text not null,
  pinned boolean not null default false,
  pinned_at bigint,
  created_at bigint not null
);

-- Liveness of the model behind an instance: last_seen moves with any call (including the wait loop), last_active
-- only with the Claude's own actions. Mission checkpoints let whoever takes a stopped mission over start where it was.
alter table claudes add column if not exists last_active bigint not null default 0;
alter table tasks add column if not exists checkpoint text not null default '';
alter table tasks add column if not exists checkpoint_at bigint;
-- Priority and deadline of a mission (deadline is a calendar day, YYYY-MM-DD, as the humans think of it).
alter table tasks add column if not exists priority text not null default 'normal';
alter table tasks add column if not exists due_date text;
-- When the human was told on Telegram that this session went silent with a mission (once per silence).
alter table claudes add column if not exists silent_alerted_at bigint;

-- Polls: a choice put to a vote among the Claudes of a room (room null = the whole station), humans included.
create table if not exists polls (
  id text primary key,
  by_claude text not null,
  project text not null default '',
  room text,
  question text not null,
  options jsonb not null,
  status text not null default 'open',
  result int,
  closed_by text,
  created_at bigint not null,
  expires_at bigint not null,
  closed_at bigint
);
-- A quiet message does not wake the waiting sessions: it is read with the next command (saves a whole wake-up).
alter table messages add column if not exists quiet boolean not null default false;
-- The astronaut's own colour (#rrggbb), when its human wants one; null = the colour derived from its id.
alter table claudes add column if not exists color text;
-- Project page of a room: the goal the humans set and its milestones ([{ text, done }]).
alter table rooms add column if not exists goal text not null default '';
alter table rooms add column if not exists milestones jsonb not null default '[]';
-- Daily summary on Telegram: the last local day sent to this human, and the switch to stop receiving it.
alter table users add column if not exists digest_day text;
alter table users add column if not exists digest_off boolean not null default false;
create table if not exists poll_votes (
  poll_id text not null references polls(id) on delete cascade,
  voter text not null,
  choice int not null,
  reason text not null default '',
  at bigint not null,
  primary key (poll_id, voter)
);
-- When the current owner took the mission (statistics: time from claim to done).
alter table tasks add column if not exists claimed_at bigint;
-- Organizations, roles and memberships (docs/DESIGN-organization-security.md). One organization per installation for
-- now; roles are sets of permissions (lib/permissions.js), the built-in ones are inserted by lib/db.js at start-up.
create table if not exists orgs (
  id text primary key,
  name text not null,
  settings jsonb not null default '{}',
  created_at bigint not null
);
create table if not exists roles (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  name text not null,
  builtin boolean not null default false,
  permissions jsonb not null default '[]',
  created_at bigint not null,
  updated_at bigint not null
);
create table if not exists memberships (
  user_id text primary key references users(id) on delete cascade,
  org_id text not null references orgs(id) on delete cascade,
  role_id text not null references roles(id),
  updated_at bigint not null
);
create index if not exists memberships_role on memberships (role_id);
-- One-off data migrations already applied (each runs once, in lib/db.js).
create table if not exists migrations (id text primary key, applied_at bigint not null);
-- Author identity and injection findings only; never copy sensitive text into this metadata table.
create table if not exists content_annotations (
  resource_key text not null,
  field text not null,
  source jsonb not null,
  findings jsonb not null default '[]',
  updated_at bigint not null,
  primary key (resource_key, field)
);
create table if not exists message_rate_guards (claude_id text primary key);
create table if not exists invites (
  id text primary key,
  org_id text not null references orgs(id),
  code_hash text not null unique,
  role_id text references roles(id) on delete set null,
  grant_scope jsonb not null default '[]',
  label text not null default '',
  created_by text not null references users(id),
  created_at bigint not null,
  expires_at bigint not null,
  reserved_by text references users(id) on delete set null,
  reserved_until bigint,
  used_by text references users(id) on delete set null,
  used_at bigint,
  revoked_at bigint
);
alter table users add column if not exists registration_invite_id text references invites(id);
alter table users add column if not exists registration_role text references roles(id) on delete set null;
alter table rooms add column if not exists visibility text not null default 'open' check (visibility in ('open', 'restricted'));
create table if not exists room_roles (
  user_id text not null references users(id) on delete cascade,
  room_id text not null references rooms(id) on delete cascade,
  role_id text not null references roles(id),
  primary key (user_id, room_id)
);
create table if not exists idea_categories (
  id text primary key,
  org_id text not null references orgs(id),
  room_id text references rooms(id),
  name text not null,
  view_roles jsonb not null default '[]',
  write_roles jsonb not null default '[]'
);
alter table notes add column if not exists room_id text references rooms(id);
alter table notes add column if not exists category_id text references idea_categories(id);
alter table invites add column if not exists room_roles jsonb not null default '[]';
alter table sessions add column if not exists admin_started_at bigint;
alter table sessions add column if not exists admin_last_seen bigint;
alter table sessions add column if not exists admin_closed_at bigint;
alter table sessions add column if not exists admin_until bigint;
alter table sessions add column if not exists ip_hash text;
alter table sessions add column if not exists public_id text unique;
create table if not exists ip_rules (
  id text primary key,
  org_id text not null references orgs(id),
  target text not null check (target in ('humans', 'agents')),
  cidr text not null,
  created_by text not null,
  created_at bigint not null
);
create index if not exists ip_rules_target on ip_rules (org_id, target);
create table if not exists security_alerts (
  id bigserial primary key,
  org_id text not null references orgs(id),
  event text not null,
  actor text not null,
  detail jsonb,
  at bigint not null
);
alter table orgs add column if not exists reception_default text not null default 'manual';
alter table rooms add column if not exists reception_default text;
alter table roles add column if not exists reception_default text;
alter table claudes add column if not exists reception_mode text;
alter table claudes add column if not exists trusted_senders jsonb not null default '[]';
alter table claudes add column if not exists token_id text;
alter table api_tokens add column if not exists suspended_at bigint;
create table if not exists held_items (
  id text primary key,
  org_id text not null references orgs(id),
  resource_key text not null,
  field text not null,
  revision text not null,
  for_claude text not null,
  owner_user text not null references users(id),
  room text,
  project text not null default '',
  source jsonb not null,
  findings jsonb not null,
  payload_enc text,
  status text not null default 'pending',
  note text not null default '',
  created_at bigint not null,
  expires_at bigint not null,
  decided_by text,
  decided_at bigint,
  unique (resource_key,field,revision,for_claude,owner_user)
);
create index if not exists held_items_open on held_items (expires_at) where status in ('pending', 'quarantined');
create table if not exists context_versions (
  project text not null,
  version int not null,
  summary text not null,
  updated_by text not null,
  updated_at bigint not null,
  source jsonb,
  primary key (project,version)
);
alter table orgs add column if not exists approval_default text not null default 'owner';
alter table rooms add column if not exists approval_rule text;
alter table api_tokens add column if not exists restrictions jsonb not null default '{}';
create table if not exists approval_votes (
  kind text not null,
  request_id text not null,
  user_id text not null references users(id) on delete cascade,
  choice text not null,
  rule text not null,
  at bigint not null,
  primary key (kind,request_id,user_id)
);
create table if not exists approval_prompts (
  kind text not null,
  request_id text not null,
  chat_id text not null,
  message_id bigint not null,
  primary key (kind,request_id,chat_id,message_id)
);
alter table sessions add column if not exists device_id text;
create table if not exists devices (
  id text primary key,
  org_id text not null references orgs(id),
  user_id text not null references users(id) on delete cascade,
  cookie_hash text not null unique,
  name text not null,
  status text not null default 'pending',
  created_at bigint not null,
  expires_at bigint not null,
  last_used_at bigint not null,
  approved_by text,
  decided_at bigint
);
create table if not exists passkeys (
  id text primary key,
  org_id text not null references orgs(id),
  user_id text not null references users(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null,
  transports jsonb not null default '[]',
  device_type text not null,
  backed_up boolean not null,
  name text not null,
  rp_id text not null,
  created_at bigint not null,
  last_used_at bigint,
  revoked_at bigint
);
create table if not exists webauthn_challenges (
  id text primary key,
  user_id text references users(id) on delete cascade,
  session_hash text,
  purpose text not null,
  challenge text not null,
  origin text not null,
  ip_hash text not null,
  name text,
  expires_at bigint not null
);
create table if not exists admin_changes (
  id text primary key,
  org_id text not null references orgs(id),
  created_by text not null references users(id),
  title text not null,
  payload_enc text,
  state_hash text not null,
  status text not null default 'pending',
  created_at bigint not null,
  expires_at bigint not null,
  decided_by text,
  decided_at bigint
);
create index if not exists devices_user on devices(user_id);
create index if not exists passkeys_user on passkeys(user_id);
create index if not exists webauthn_challenges_expiry on webauthn_challenges(expires_at);
create index if not exists admin_changes_pending on admin_changes(expires_at) where status='pending';
alter table orgs add column if not exists model_key_enc text;
create table if not exists model_check_cache (
  id text primary key, org_id text not null references orgs(id), verdict text not null, expires_at bigint not null
);
create table if not exists model_check_usage (
  id text primary key, org_id text not null references orgs(id), day text not null, at bigint not null
);
create index if not exists model_check_daily on model_check_usage(org_id,day);
`;
