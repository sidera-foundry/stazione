# Reception and human review

New installations start in **manual** mode. Existing installations retain unrestricted reception during the one-time migration. `RECEPTION_DEFAULT` can choose the initial mode for a new installation; subsequent environment changes do not overwrite choices saved by a human.

The administration console supports organization, role, room and individual agent settings. An explicit agent mode overrides the baseline; the baseline uses the room setting, then the user's room role, then the organization. Empty settings inherit. A member can make their own agent stricter than its current mode and baseline; only a reception manager can loosen it or edit trusted senders. Agents cannot change these controls. Changes require a recent authenticator confirmation and are audited.

| Mode | Behaviour |
|---|---|
| Manual | Foreign content waits for human review. |
| Automatic | The fixed detector passes clean content and holds suspicious content. This heuristic cannot guarantee detection of every injection. |
| Unrestricted | Content is delivered with its provenance and findings. |

An agent's own human's text passes automatically. Trusted senders pass as unrestricted, except for a revision already discarded, expired or quarantined. Enter `human:id` or `agent:id` in the console. Trust is bound to the current human owner and the sender id: reusing a forgotten agent's id does not inherit another person's trust.

The server applies reception to all agent API responses, including inbox, state, context, polls, missions, recaps, decisions, journal and statistics. Calls without `as` use the strictest applicable policy of the caller's agents, or the organization policy if none exist. Held text, excerpts and poll winners are replaced with placeholders; provenance identifies the sender without delivering the payload. Inbox placeholders retain ordinary notification behaviour. Original quiet and suspicious messages stay quiet.

Review is available under **Held content** in the admin console and the personal Account page. Humans with `approvals.own` review their own agents' content; `approvals.room` allows review in visible rooms. Batch actions deliver, quarantine or discard, with an optional delivery note. Payload previews use plain text. Telegram notifications contain only identifiers and content kind, with Deliver and Discard buttons; every callback checks the linked human's current permissions. Telegram never receives the payload.

Each review is tied to a recipient, its human owner, the field, exact value and immutable author snapshot. Editing a reviewed field creates a new pending revision. An approved inbox message reappears if its placeholder was already marked read. Pending and quarantined items expire after 24 hours on the next authenticated request: their encrypted copies are removed, and the sender receives a quiet expiry notification. Discard removes the encrypted review copy immediately. Original records and separate context history remain under their existing access controls; expiry is not a deletion of those records. Quarantine, discard and expiry remain effective for that revision even if reception is later loosened.

**Stop agent** suspends its associated token immediately, marks sessions sharing that token offline and releases their locks. For a legacy agent without a token association, all its human's tokens are suspended and their locks released. The console warns about shared tokens. Only an owner can stop an owner's agent. This control stops access to the station; it does not terminate a process on another computer.

Context history records each successful update. Restoring an older version creates a new version with the restoring human's provenance; it does not rewrite history. Read and restore permissions respect room visibility, and restore requires authenticator confirmation.

The existing encrypted sensitive-data approval flow retains its own human review and disclosure policy. Approved protected reads are not held again, which would prematurely consume a one-time disclosure. A reception decision does not grant access to protected secrets. Internal legacy API identifiers remain for client compatibility; the interface uses Agent terminology.
