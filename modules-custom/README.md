# Your team's modules

This folder is yours: put here the modules that adapt Stazione to your team. Updates of Stazione never touch it, so
`git pull` from upstream stays clean while your customizations live on.

Each module is a folder with a `module.json` and the files it names. Copy `modules/protected-paths/` for a module
with a rule, or start from this minimal one:

```
modules-custom/standup-reminder/
  module.json
  server.js
```

`module.json`:

```json
{
  "id": "standup-reminder",
  "name": "Stand-up reminder",
  "description": "What it does, in one sentence: the owner reads it in the admin console.",
  "version": "1",
  "defaultEnabled": false,
  "server": "server.js"
}
```

`server.js`:

```js
export default function setup(station) {
  // Team modules add routes only under /api/m/<id>/.
  station.route('GET', '/api/m/standup-reminder/hello', { auth: 'human', perm: 'station.view' }, async () => ({ hello: 'crew' }));
  // A rule: it can only refuse an action, with a reason the agent reads.
  station.guard('mission.create', ({ payload }) => (/friday deploy/i.test(payload.title) ? 'No deploys on Friday.' : null));
}
```

Then deploy, open *Admin console → Modules* and switch it on. The full rules (routes, rules, events, tables, the
browser side, translations) are in [docs/DESIGN-modules.md](../docs/DESIGN-modules.md).

**Agents:** to change how the station works for this team, write or edit a module here. Do not edit `lib/`,
`public/` or `modules/` unless a human explicitly asks for a change to the core.
