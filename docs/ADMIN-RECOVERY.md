# Admin network access and recovery

Critical changes require a recent authenticator or passkey confirmation, valid for five minutes and tied to the current session
and network address. A newly completed MFA sign-in supplies that confirmation. Tokens cannot confirm a human's identity.
This check also protects the original panel endpoints, not only `/api/admin/*`.

The console accepts IPv4 and IPv6 addresses or CIDR ranges separately for people and agents. An empty list allows all
networks. A new list for people must include the administrator's current address. On a self-hosted server, leave
`TRUST_PROXY=0` unless a trusted proxy overwrites the client-address headers; the default server ignores supplied headers.

If network, registered-browser or four-eyes restrictions block access, use a trusted shell **on the server**, with the same database, encryption key
and password pepper as the installation:

```sh
node scripts/admin-recover.js --confirm
```

This clears both allowlists, disables registered-browser and four-eyes requirements, expires pending administrative
changes, reserves capacity for one additional person, and displays a single-use owner invite,
valid for one hour. Keep the displayed code private; use it on `/register` to enroll an owner with a password and MFA.
The script requires an existing active owner. It records the change in the audit log and console security alerts.
It never disables MFA or publishes an HTTP recovery endpoint. Review all security policies and the recovery account afterwards.
See [passkeys, browsers and independent approval](CONSOLE-SECURITY.md) for setup and recovery details.

Owners and administrators receive console and Telegram alerts for critical changes when Telegram is linked.
Sign-in sessions can be closed individually; closing one invalidates its cookie immediately. Owners' sessions may
only be closed by an owner. Session metadata contains opaque display identifiers, never a cookie or its stored hash.

IP matching uses Node's built-in [`net.BlockList`](https://nodejs.org/api/net.html#class-netblocklist), including
IPv4-mapped IPv6 addresses; the proxy must provide the real client address for allowlists to be meaningful.
