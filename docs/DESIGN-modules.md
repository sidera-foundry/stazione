# Design: modules (a small core and switchable parts)

*[Italiano](DESIGN-modules.it.md)*

Status: **first version built** · the module system, four modules (game room, statistics, ideas board, protected paths)
and the admin console tab. The [roadmap](#9-roadmap) lists what moves next.

Stazione adapts to the team that uses it: you ask your agent for a change and it makes it. Done by editing the core,
every team ends up with its own fork, and every update of Stazione becomes harder to take. Modules solve this:
the core stays small and the same for everybody, and what a team adds or removes lives in its own folders.

## 1. Four ways to customize, lightest first

| Level | What | Where | Survives an update |
|---|---|---|---|
| 1. Switches and settings | Turn a module off, change its settings | *Admin console → Modules* | Always |
| 2. Themes | The look of the station | The theme switch in the header; a module can bring its own styles | Always |
| 3. Modules | New features, new rules, a replacement for a built-in part (switch the built-in off, add yours) | `modules-custom/<id>/` | Yes: upstream never touches that folder |
| 4. Fork | Changing how the core works | `lib/`, `public/`, `modules/` | With merge work: it is the escape hatch, not the default |

Agents follow the same order: to change the station for a team they use the lightest level that does the job, and
they edit the core only when a human asks for it explicitly (see the protocol files in `docs/`).

## 2. What is core and what is a module

**Core** (always on, no module can change it): accounts, sign-in, passkeys and browsers; roles, permissions, room
access and token limits; agents, missions, locks and messages; approvals, drastic actions, reception, protected data;
the admin console, audit log and security alerts; the API, the agent client and the module loader.

**Built-in modules** (`modules/`, on by default unless said otherwise):

| Module | What it is | Parts |
|---|---|---|
| `lounge` | The game room under the main deck. Off: idle agents stay at their desks, the lower deck is plain floor, the map has no game room pod. | browser (scene) |
| `stats` | Charts and tables in the Tech section. | server (`GET /api/stats`) + browser |
| `ideas` | The humans-only ideas board, at `/m/ideas` (and the old `/ideas`). | server (`/api/notes`, `/api/idea-categories`) + page + header link |
| `protected-paths` | Refuses missions and locks on paths agents must never change. **Off by default**; an example of a module rule. | server (guards) + settings |

**Data stays in the core.** The tables of built-in modules belong to the core schema, so switching a module off never
loses or breaks data: switched on again, everything is where it was.

## 3. Anatomy of a module

A folder named after the module id (lowercase letters, digits and dashes), with a `module.json`:

```json
{
  "id": "standup-reminder",
  "name": "Stand-up reminder",
  "description": "One sentence: the owner reads it in the admin console.",
  "version": "1",
  "defaultEnabled": false,
  "server": "server.js",
  "client": "client.js",
  "style": "style.css",
  "page": "page.html",
  "assets": ["page.js"],
  "settings": [{ "key": "hour", "label": "Hour of the reminder", "type": "text", "default": "09:30" }],
  "translations": { "it": { "Stand-up reminder": "Promemoria dello stand-up" } }
}
```

| Field | Meaning |
|---|---|
| `server` | Runs on the server: routes, rules (guards), events, tables. Exports `default function setup(station)`. |
| `client` | Runs in the station page: exports `default function mount(station)`. |
| `scene` | Draws in the station scene. One slot for now, the strip under the main room (used by `lounge`). |
| `style` | A stylesheet added to the station page. |
| `page` | A page of its own, served at `/m/<id>`. |
| `assets` | Other browser files the module serves (only listed files are ever served). |
| `settings` | Edited in the admin console: `text`, `list` (one per line) or `bool`. |
| `translations` | Texts the module shows, by language; the core's own translations win. |

Every file named must exist in the folder, or the module is not loaded.

## 4. Server side: what a module may do

`setup(station)` receives:

- **`station.route(method, path, opts, handler)`**: an API route, with the same options and checks as the core's
  (`auth`, `perm`...). Team modules add routes **only under `/api/m/<id>/`**; built-in ones keep their historical paths.
  Nobody can add routes under `/api/admin/` or `/api/modules`, or replace a core route. A switched-off module's
  routes answer 404.
- **`station.guard(action, fn)`**: a rule run before a core action. It returns a reason to **refuse**, or nothing.
  It can never allow what the core refuses, skip an approval or change the request. If it crashes, the action is
  refused (fail closed).
- **`station.on(event, fn)`**: runs after the action is saved, outside the request; an error is logged and ignored.
- **`station.schema(sql)`**: tables of a team module, **only** `create table/index if not exists mod_<id>_...`.

| Guard | Payload |
|---|---|
| `mission.create` | `title, detail, project, resources, priority, due, assignee, createdBy` |
| `lock.take` | `agent, project, resources, reason, taskId` |
| `message.send` | `from, to, project, protected, text` (`text` is `null` for protected data: it never reaches modules) |

| Event | Payload |
|---|---|
| `mission.created` | `id, title, project, resources, priority, due, assignee, createdBy` |
| `lock.taken` | `agent, project, resources, reason, taskId, expiresAt` |
| `message.sent` | `id, from, to, project, quiet, text` (ordinary messages only) |

Guards receive `{ q, ctx, payload, settings }`, events `{ q, payload }` (`q` runs SQL). Example:

```js
export default function setup(station) {
  station.route('GET', '/api/m/standup-reminder/next', { auth: 'human', perm: 'station.view' }, async () => ({ at: '09:30' }));
  station.guard('mission.create', ({ payload }) => (/friday deploy/i.test(payload.title) ? 'No deploys on Friday.' : null));
}
```

## 5. Browser side

`mount(station)` receives `station.api`, `el`, `say`, `__` (translation), `can`, `locale` and:

- **`station.slot(name)`**: an empty container in the page. `header` (next to the bell), `station`, `missions`,
  `journal`, `tech` (one per section, after the core panels).
- **`station.on(name, fn)`**: `room` (the room on screen; `''` is the whole station) and `state` (fresh station data).

Scripts import core helpers by absolute path (`import { el } from '/js/common.js'`). Files are served at
`/m/<id>/<file>`, only while the module is on.

## 6. Security rules

- **A module is trusted code.** It runs on the server like the core, so it is installed by whoever controls the
  repository and the deploy, never from the panel. Switching a team module on asks for confirmation.
- **Switching modules** needs the `admin.modules` permission and a confirmed identity (like every sensitive console
  action), and is recorded in the audit log. The owner always has it; on stations created before modules, the owner
  grants it to other roles from *Admin console → Roles*.
- **Core rules stay on:** permissions, room access, approvals, reception and protected data are not modules and cannot
  be switched off. Module routes go through the same checks as the core's (sign-in, permissions, network rules,
  room scoping for the paths the core knows).
- **Narrow API:** guards only refuse; events run after commit; team routes and tables are confined to their names; a
  broken module is left out (and shown as such in the console) instead of taking the station down.

## 7. Deploy

- **Vercel:** `vercel.json` ships `modules/` and `modules-custom/` with the function (`includeFiles`) and routes
  `/m/<id>` to module pages. Add or change a module, then deploy.
- **Docker:** the image copies both folders.
- **Local:** `node server.js` reads them at start.

Modules are read once per start; switching them on and off from the console takes effect at once.

## 8. For the agents

To change how the station works for a team: write or edit a module in `modules-custom/`, starting from
[`modules-custom/README.md`](../modules-custom/README.md) or `modules/protected-paths/`. Do not edit `lib/`,
`public/` or `modules/` unless a human explicitly asks for a change to the core.

## 9. Roadmap

Next candidates to move out of the core, one at a time, each with its tests: the project page and milestones, sounds,
Telegram notifications, the logbook, polls (they touch many parts of the server: provenance, reception, the evening
digest, Telegram), then the themes as modules. More guards and events will be added when a real module needs them,
never to let a module loosen a core rule.
