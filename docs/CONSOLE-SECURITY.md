# Passkeys, registered browsers and independent approval

All three features are enforced by the server. Existing installations keep their
current sign-in behaviour: passkeys are optional and both security switches start
off. No authentication or device-management endpoint accepts an agent token.

## Passkeys

In **Account → Passkeys and browsers**, add a named passkey after confirming your
identity. Owners and administrators are encouraged to register one. Sign in using
the passkey button, or use a passkey instead of a new TOTP code for a protected
action. Password plus TOTP and recovery phrases remain available.

Verification uses `@simplewebauthn/server`. Registration requests resident
credentials, user verification and ES256 or RS256. Sign-in requires user presence
and verification. The server checks the signature, challenge, origin, RP ID and
authenticator counter. Counters of zero are supported for authenticators that do
not maintain them; positive counters cannot move backwards. Embedded ceremonies
are refused. Private keys stay in the authenticator. Only public credentials and
safe display metadata are stored; list endpoints do not disclose credential IDs
or public keys.

Challenges last five minutes, are bound to purpose, origin and client IP, and can
be used once. Registration and step-up also bind the current person and session.
A failed cryptographic verification consumes the challenge. Challenge issuance is
rate limited. A person can have up to ten active passkeys. Revocation blocks future
passkey use; use session closure or account recovery to end existing sign-ins.

Configure a stable HTTPS `APP_ORIGIN` in production. The RP ID is its hostname, so
credentials cannot move to another hostname. Localhost HTTP is allowed for local
development. Do not infer a physical-device restriction from a passkey: providers
may sync it across devices. Use a hardware authenticator and appropriate provider
policy when physical custody is required.

## Registered browsers

Sign-in registers a browser automatically. Existing sessions can register their
current browser from Account. The server stores only the hash of a random
`__Host-stz_d` cookie. It is Secure, HttpOnly, SameSite=Strict, scoped to `/`, and
expires after 90 days. Names can be edited in Account; approval and revocation are
in **Admin → Passkeys and browsers**. Only an owner can change an owner's browser
or revoke an owner's passkey.

To enable **Require approved browsers**, first register and approve the current
browser. At least one active owner must also have an approved browser. Enabling
the switch affects existing sessions as well as new sign-ins: both the session
and its matching approved browser cookie must be present and unexpired.

After password plus TOTP or a passkey succeeds on an unknown browser, the server
issues a 15-minute pending request rather than a full session. The sign-in page
lets the person check its approval. An administrator approves it from a different
authorized session; the pending cookie, browser cookie and original IP must still
match before a full session can be issued. Revoke a browser to close every bound
session. The last approved active-owner browser cannot be revoked while the
requirement remains on. Cookie expiry or clearing browser data requires approval
again. A cookie identifies a browser installation, not a MAC address or a physical
computer; copying it is not equivalent to hardware attestation.

## Four-eyes approval

**Require a second administrator for sensitive changes** needs at least two active
organization owners/admins with console, security and people-management access.
The server returns HTTP 202 with `status: pending_approval`, `changeId` and
`expiresAt`. It applies no change until a distinct current owner/admin approves it
with fresh step-up confirmation. The console displays the proposed operation,
target and settings. The original human APIs and console aliases share the same
enforcement.

Covered operations:

- Grants of administrative roles or permissions, including organization roles,
  room roles and invitations.
- Broader IP allowlists, opening restricted rooms, and changes to approval rules
  away from two-person approval.
- Non-manual reception or trusted-sender exceptions (conservatively queued).
- Relaxing token restrictions, disabling registered-browser sign-in, or disabling
  four-eyes approval itself.

Both people must retain the permissions and room access needed for the operation.
An administrator can countersign a grant initiated by an owner, including an owner
grant, while retaining the administrator's actual grant ceiling. The administrator
cannot initiate owner changes. The executing handler still checks the initiating
owner, target, permission ceiling and last-owner protection.

Requests expire after 30 minutes. An organization-wide fingerprint invalidates
them when security-relevant roles, memberships, rooms, IP rules, token restrictions
or reception settings change, even if that change concerns another target. Reject
and submit a fresh request in that case. The requesting human's full session must
still be valid; when registered browsers are required, its approved browser must
still be valid too. Closing that session requires a fresh submission. Rejecting a
request never applies it, and the creator may reject their own request.

The pending payload is encrypted and includes the original request and session
reference. Only whitelisted proposal fields are displayed to organization
owners/admins. Credential material, session references and ciphertext are never
listed or logged. Terminal requests have their payload erased. Expiry cleanup runs
when the list is read and through the existing cleanup cron. A privileged invite
is minted only at approval; its code is shown once to the approving human, never
in the request list or audit. Save that code before leaving the page.

## Recovery and self-hosted device controls

Account recovery revokes all old sessions, agent tokens, passkeys and browsers. If
approved browsers are required, the recovering person needs a new approval too.

For an installation-wide lockout, run `node scripts/admin-recover.js --confirm`
locally on the configured server. It clears IP allowlists, disables the registered
browser and four-eyes requirements, expires outstanding administrative requests,
reserves an available user seat, and creates a one-time owner invite valid for one
hour. This operation has no HTTP endpoint, is audited, and emits a security alert.
Keep the printed invite private, then restore the desired policy after recovery.

Self-hosted installations can require client certificates at their reverse proxy
for an additional device boundary. Configure a trusted issuing CA, require a valid
client certificate for all application routes, and prevent direct access to the
upstream server. Keep proxy identity/IP headers trusted only from that proxy;
never accept certificate identity supplied by an untrusted HTTP client. This is a
deployment control, independent of WebAuthn and browser cookies.

See [the organization design](DESIGN-organization-security.md),
[the emergency recovery procedure](ADMIN-RECOVERY.md) and
[SimpleWebAuthn's server documentation](https://simplewebauthn.dev/docs/packages/server).
