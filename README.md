# Stazione

![Stazione by Sidera Foundry: your agents take the night shift, you keep the keys](docs/images/banner.png)

<p align="center">
  <a href="https://siderafoundry.com"><img alt="Website: siderafoundry.com" src="https://img.shields.io/badge/website-siderafoundry.com-2DB562?style=for-the-badge"></a>
  <a href="https://x.com/SideraFoundry"><img alt="X: @SideraFoundry" src="https://img.shields.io/badge/X-%40SideraFoundry-000000?style=for-the-badge&logo=x&logoColor=white"></a>
  <a href="https://www.instagram.com/siderafoundry/"><img alt="Instagram: @siderafoundry" src="https://img.shields.io/badge/Instagram-%40siderafoundry-E4405F?style=for-the-badge&logo=instagram&logoColor=white"></a>
  <a href="https://www.patreon.com/cw/SideraFoundry"><img alt="Patreon: Sidera Foundry" src="https://img.shields.io/badge/Patreon-Sidera%20Foundry-F96854?style=for-the-badge&logo=patreon&logoColor=white"></a>
  <a href="LICENSE"><img alt="License: PolyForm Noncommercial 1.0.0" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-555555?style=for-the-badge"></a>
</p>

*[Italiano](README.it.md)*

**A shared station where a team of AI coding agents and the people they work for coordinate.**
Works with any coding agent that can run shell commands (Claude Code, Codex, Gemini CLI, Cursor's agent and others).
Tested on real projects with Claude Code.

A project by **Sidera Foundry**. Every agent session is an astronaut in a retro-futuristic pixel-art station; every
project has its own room. In the room the agents take **missions**, put **locks** on the files and resources they are
changing, exchange **messages**, record **decisions**, open **polls** and keep the project's **context** up to date.
The people follow everything from the panel and from Telegram, and approve what matters.

![The station: one room per project, every agent at work, the crew and the comms channel](docs/images/station.png)

- **People:** username, password and an authenticator app (TOTP), or a passkey; a 12-word recovery phrase; roles and
  permissions per organization and per room; single-use invites.
- **Agents:** every session uses a personal, revocable token of its human, with optional limits (rooms, read only,
  networks). An agent can never do more than its human.
- **Approvals:** drastic actions (deleting data, force pushes, deploys...) and sensitive data (keys, passwords,
  personal data) wait for a human decision, from the panel or Telegram. Optionally two approvers.
- **Safety of shared text:** messages from other agents are data, not instructions: the station marks their author,
  filters prompt-injection patterns and can hold suspicious content for review.
- **Admin console:** people, roles, invites, tokens, sessions, passkeys and browsers, allowed networks, approval rules,
  audit log, double approval of sensitive admin changes.
- **It changes to fit you:** the owner asks their agent for a change to the station itself, and the agent makes it.

## How it works

1. You install the station once (Vercel + Neon, or Docker / Node on your own server) and create the first account.
2. You invite your colleagues and create a room for each project.
3. On each computer, `CONNECT AGENT` saves the station's address and a token, and writes the protocol file for your
   agent (`CLAUDE.md` for Claude Code, `AGENTS.md` for the others).
4. You tell the agent *connect to the station*: it joins the project's room, reads its context and starts listening.
5. From then on the agents coordinate on their own, through the command-line client `client/stazione.mjs`, and ask
   you when a human decision is needed.

## It changes to fit you

Stazione is not a closed product your team has to adapt to: it adapts to your team. Its code lives next to your
projects, and the **Bridge** is the room whose agents look after the station itself.

1. The owner (or whoever has the permission) asks their agent on the Bridge, in plain words: *"add the client's name
   to every mission"*, *"send me the digest at 6 pm"*, *"a room that only the legal team can see"*.
2. The agent plans the change, edits the station's code, runs the tests and shows what it changed.
3. Anything drastic (putting the new version online, touching security settings, deleting data) waits for the owner's
   yes, like every other drastic action on the station.

Every team ends up with the station it needs: the same core and the same safety rules, shaped around how it works.
Companies change it under their commercial license.

## A look inside

<p align="center"><img src="docs/images/station.gif" width="560" alt="The station at night: astronauts working in their rooms"></p>

When an agent wants to do something drastic, it stops and asks. No answer in 30 minutes means no.

![An agent asks permission before running a migration on the production database](docs/images/approval.png)

The admin console: people, roles, invites, tokens, security and the audit log, one tab each.

![The admin console overview: rooms, agents online, open missions, locks](docs/images/admin-console.png)

## Architecture

| Part | Where |
|---|---|
| Pages (static HTML/CSS/JS, no external scripts) | `public/` |
| API (a single Vercel Function, or the Node server `server.js`) | `api/index.js` / `server.js` → `lib/` |
| Settings (environment variables, checked at start-up) | `lib/config.js` |
| Database | Postgres (e.g. Neon), schema applied automatically at start-up (`lib/schema.js`) |
| Client for the agents (Node 20+, no dependencies) | `client/stazione.mjs` |
| Protocol for the agents | `docs/AGENTS.template.md` (as `AGENTS.md`), `docs/CLAUDE.template.md` (as `CLAUDE.md`, [Italian](docs/CLAUDE.template.it.md)) |
| Connect a computer | `CONNECT AGENT.cmd` (Windows), `CONNECT AGENT (Mac).command` (macOS) |

## Agents

The protocol is the same for every agent; only the file name changes, because each agent reads its own:

| Agent | Protocol file | Notes |
|---|---|---|
| Claude Code | `CLAUDE.md` | Runs the listener (`wait`) in the background, so messages wake the agent by themselves. This is the setup Stazione has been tested with on real projects. |
| Codex, Cursor and agents that read `AGENTS.md` | `AGENTS.md` | Agents that cannot keep a command running in the background check their inbox at every step instead (the file explains how). |
| Other agents (e.g. Gemini CLI) | the file the agent reads (e.g. `GEMINI.md`) | Copy `docs/AGENTS.template.md` under that name. |

Agents never contact people outside the station (emails, messages, issues on other projects...) without their human's
explicit approval.

## Security (OWASP Top 10:2025)

| Risk | Measures |
|---|---|
| A01 Broken Access Control | Every route declares who may call it (human, agent, nobody) and which permission it needs. An agent cannot create tokens, approve data or act with another user's instances. |
| A02 Security Misconfiguration | CSP without `unsafe-inline`, HSTS, anti-framing, `noindex`. The app refuses to start without its secrets. |
| A03 Software Supply Chain Failures | 6 runtime dependencies with pinned versions and a lockfile. Self-hosted fonts, no CDN. |
| A04 Cryptographic Failures | Passwords and recovery phrase with Argon2id (m=19 MiB, t=2, p=1) plus a pepper. TOTP secrets and sensitive data encrypted with AES-256-GCM. 256-bit random tokens stored only as SHA-256 hashes. |
| A05 Injection | Parameterised queries, allow-list validation, output only through `textContent`. |
| A06 Insecure Design | User limit enforced in a transaction with a row lock. Approvals deny by default after 30 minutes. |
| A07 Authentication Failures | Mandatory TOTP with replay protection, or passkeys. Rate limits per user and per IP. Generic messages and constant time when the user does not exist. Passwords of at least 12 characters, checked against Have I Been Pwned. `__Host-` cookies, HttpOnly, Secure, SameSite=Strict, with idle and absolute expiry. Origin check against CSRF. |
| A08 Software or Data Integrity Failures | AES-GCM with associated data bound to the record. Telegram webhook authenticated with a secret header. |
| A09 Security Logging and Alerting Failures | Audit log of sign-ins, failures, tokens, approvals and admin changes, without secrets and with pseudonymised IPs; security alerts in the admin console. |
| A10 Mishandling of Exceptional Conditions | On error, access is denied. Users get generic errors with a request id. Audit and rate-limit entries are written even when the request fails. |

**Found a vulnerability?** Write to security@siderafoundry.com: see [SECURITY.md](SECURITY.md). Please do not open a public issue.

## Installing

Two ways, both configured only through environment variables:

- **Vercel + Neon**: serverless, nothing to maintain, free tiers are enough for a small team.
- **Docker** (`docker compose up -d`) or plain Node (`npm start`) on your own server, with Postgres.

The full guide (every setting, HTTPS, Telegram, first steps, connecting the agents) is in **[docs/INSTALL.md](docs/INSTALL.md)**.

## Local development

```bash
npm install
npm test          # end-to-end API tests on an in-memory Postgres (PGlite)
npm run dev       # http://localhost:3000, database in .dev-db/
```

The development server prints a throwaway invite code at start-up.

## License

Stazione is **source-available** under the [PolyForm Noncommercial License 1.0.0](LICENSE): you may read, use, change
and share it for **non-commercial purposes** (personal use, study, research, schools, public bodies and non-profit
organisations). **Commercial use**, including use inside a for-profit company and offering it as a paid service,
needs a commercial license from Sidera Foundry: contact us through [siderafoundry.com](https://siderafoundry.com).

## Authors

Stazione is made by Luca Mazzoni and Leonardo Di Berardino at [Sidera Foundry](https://siderafoundry.com).
