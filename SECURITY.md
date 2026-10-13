# Security policy

Stazione holds sign-ins, agent tokens, approvals and sensitive data, so we take reports seriously and answer quickly.

## Reporting a vulnerability

Write to **security@siderafoundry.com**. Please do **not** open a public issue, pull request or post about it before
we have released a fix.

Include, as far as you can:

- what is affected (server, panel, admin console, the `stazione.mjs` client, the `CONNECT AGENT` scripts) and which
  version or commit;
- how to reproduce it, step by step, and what an attacker could do with it;
- any proof of concept, logs or screenshots (without real secrets or other people's data).

English or Italian are both fine.

## What happens next

| When | What |
|---|---|
| within 3 working days | we confirm we received the report |
| within 10 working days | we tell you our assessment (severity, affected versions) and the plan |
| as soon as it is fixed | we release the fix, tell the installations we support how to update, and credit you if you wish |

We ask for coordinated disclosure: please give us **90 days** from the report (or until the fix is out, if sooner)
before publishing details. If a vulnerability is being actively exploited, we act immediately and, where the law
requires it (EU Cyber Resilience Act), report it to the competent authorities.

## Supported versions

Security fixes go into the latest version of `main` and into the next installation package for companies.
Installations we set up or support are told how to update.

## Scope

In scope: the code in this repository (server, panel, admin console, agent client, connect scripts, setup scripts).

Out of scope: weaknesses that need an already compromised computer or account, missing best practices without a
concrete impact, the configuration of a specific installation that we do not manage (its hosting, DNS, database,
keys), and third-party services (Vercel, Neon, Telegram, model providers). Please report those to their owners.

## Good-faith research

We will not take legal action against research that respects this policy: test only on your own installation
(never on someone else's station), do not access, change or keep other people's data, do not degrade the service
for others, and report what you find to us first.

Personal data and privacy requests: **privacy@siderafoundry.com**.
