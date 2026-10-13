// Permissions and roles. A permission is one precise action, checked by the server on every request; the list is
// fixed here. A role is a named set of permissions, stored in the database and editable by whoever has admin.roles.
// An agent acts with the permissions of its human (never more). See docs/DESIGN-organization-security.md.
import { fail } from './http.js';

export const ORG_ID = 'default'; // one organization per installation for now (milestone 9 adds more)

/** Every permission, with what it allows (shown in the admin console). */
export const PERMISSIONS = {
  'station.view': 'See the panel and the rooms you have access to',
  'missions.create': 'Create missions',
  'missions.assign': 'Assign missions to an agent, change priority and due date',
  'missions.manage': 'Close, block or reopen missions of others',
  'missions.work': 'Work on missions: take them, lock resources, write checkpoints',
  'messages.send': 'Send messages, recaps and decisions',
  'rooms.create': 'Open rooms',
  'rooms.merge': 'Merge rooms',
  'rooms.project': 'Edit a room\'s goal and milestones',
  'rooms.context': 'Write the project context (read by every agent at the start of a session)',
  'claudes.tokens': 'Create and revoke tokens for your own agents, remove your old astronauts',
  'claudes.manage': 'Remove astronauts, release locks and stop agents of others',
  'claudes.reception': 'Set the reception mode of agents',
  'approvals.own': 'Approve sensitive data and drastic actions of your own agents',
  'approvals.room': 'Approve those of every agent in the room',
  'polls.open': 'Open polls',
  'polls.vote': 'Vote',
  'polls.decide': 'Close polls early and settle ties',
  'ideas.use': 'Use the ideas boards',
  'ideas.manage': 'Create idea categories and decide which roles see and write each one',
  'people.invite': 'Invite people (only to roles you could assign)',
  'people.manage': 'Change roles, remove accounts, close sessions',
  'admin.console': 'Open the admin console',
  'admin.roles': 'Create and edit roles',
  'admin.security': 'Security settings: user limit, allowed IPs, approval rules, injection filter',
  'admin.audit': 'Read the audit log',
};
export const ALL = Object.keys(PERMISSIONS);

const MEMBER = ['station.view', 'missions.create', 'missions.work', 'messages.send', 'rooms.project', 'rooms.context',
  'claudes.tokens', 'approvals.own', 'polls.open', 'polls.vote', 'ideas.use'];

/** Built-in roles: created at start-up, editable (except the owner, who always has everything), never deleted. */
export const BUILTIN_ROLES = [
  { id: 'owner', name: 'Owner', permissions: ALL },
  { id: 'admin', name: 'Admin', permissions: ALL },
  { id: 'lead', name: 'Project lead', permissions: [...MEMBER, 'missions.assign', 'missions.manage', 'claudes.manage', 'claudes.reception', 'approvals.room', 'polls.decide', 'ideas.manage', 'people.invite'] },
  { id: 'member', name: 'Member', permissions: MEMBER },
  { id: 'guest', name: 'Guest', permissions: ['station.view'] },
];

/** Keeps only real permissions, without duplicates, in the canonical order. */
export const cleanPermissions = (list) => ALL.filter((p) => Array.isArray(list) && list.includes(p));

/** The role and permissions of a user (the owner always has every permission, whatever is stored). */
export async function loadAccess(q, userId) {
  const [m] = await q.query(
    'select r.id, r.name, r.permissions from memberships m join roles r on r.id = m.role_id where m.user_id = $1 and m.org_id = $2',
    [userId, ORG_ID],
  );
  if (!m) return { role: null, roleName: null, permissions: new Set() };
  return { role: m.id, roleName: m.name, permissions: new Set(m.id === 'owner' ? ALL : cleanPermissions(m.permissions)) };
}

export const can = (principal, permission) => Boolean(principal?.permissions?.has(permission));

/** Stops the request unless the caller (a human, or an agent through its human) has the permission. */
export function need(ctx, permission) {
  if (!can(ctx.principal, permission)) {
    fail(403, `Your role does not allow this (${PERMISSIONS[permission] ? permission : 'unknown permission'})`);
  }
}
