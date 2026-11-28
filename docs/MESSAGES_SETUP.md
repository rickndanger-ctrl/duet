# Text messages setup

Duet reads and sends texts through **macOS Messages** on the Mac that runs the Duet server. That Mac must be
signed in to Messages with the same Apple ID as your iPhone. For SMS (green bubbles) as well as iMessage, turn on
iPhone → Settings → Apps → Messages → Text Message Forwarding → this Mac.

## Why a helper over ssh

macOS keeps `~/Library/Messages` behind Full Disk Access. A server started by launchd doesn't have it, and giving
it to `node` would give it to every Node script on the Mac. Instead, the server runs one small script,
`server/messages-helper.mjs`, over ssh to localhost (Remote Login has Full Disk Access). The ssh key may run
**only** that script, only from this Mac:

```bash
ssh-keygen -t ed25519 -N '' -C duet-messages -f ~/.ssh/duet_messages
echo "command=\"$(which node) $HOME/Services/duet/server/messages-helper.mjs\",from=\"127.0.0.1,::1\",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding $(cat ~/.ssh/duet_messages.pub)" >> ~/.ssh/authorized_keys
```

(Adjust the helper path to where the server lives.) Remote Login must be on: System Settings → General → Sharing →
Remote Login, with "Allow full disk access for remote users" checked. Restart the server; `/health` then shows
`"messages": true`. `DUET_MESSAGES=off` turns texts off; `DUET_MESSAGES=direct` runs the helper in-process, for a Mac
where node already has Full Disk Access.

The first text you send may make macOS ask once whether to let the helper control Messages; allow it.

## What it can do

- `messages_recent`: recent incoming texts with contact names (names come from Contacts on the same Mac).
- `messages_thread`: the last messages with one person, both ways.
- `messages_send`: a text to a contact name, number or email. The lens shows `Text Sam Lee "On my way!"`; nothing is
  sent until you say yes. If a name matches several contacts, Duet asks which one.

Message text goes to Claude only when you ask about your texts, is never written to disk by Duet, and is dropped with
the conversation after 30 minutes.
