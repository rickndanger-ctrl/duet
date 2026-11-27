# Connect Duet to Google Calendar and Gmail (one time, ~5 minutes)

Duet uses your own Google Cloud OAuth client, so your mail and calendar only ever go between Google,
your Duet server and Claude.

## 1. Make the OAuth client

1. Open <https://console.cloud.google.com/projectcreate> and create a project named **Duet**.
2. Turn on the two APIs (make sure the Duet project is selected at the top):
   - <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>: **Enable**
   - <https://console.cloud.google.com/apis/library/gmail.googleapis.com>: **Enable**
3. Open <https://console.cloud.google.com/auth/overview> and click **Get started**:
   - App name **Duet**, your email as support email, Audience **External**, your email as contact, **Create**.
4. **Audience** (left menu) → **Test users** → **Add users** → add your own Gmail address → **Save**.
   (In Testing mode only listed test users can sign in. Nothing needs Google review.)
5. **Clients** (left menu) → **Create client** → Application type **Desktop app**, name **Duet** → **Create**
   → **Download JSON**. You get a file like `client_secret_1234-abc.apps.googleusercontent.com.json`.

## 2. Sign in once

On a computer with a browser, in the repo:

    cd server && node google-auth.mjs ~/Downloads/client_secret_*.json

Your browser opens: pick your Google account. You'll see "Google hasn't verified this app": click
**Continue** (it's your own app). Allow Calendar and Gmail. The script writes `~/.config/duet/google.json`.

If the server runs on another machine, copy that file to the same place there (`~/.config/duet/google.json`,
mode 600) and restart the server. `GET /health` then shows `"google": true`.

## What Duet can do with it

| You say | Duet does |
|---|---|
| "What's my next meeting?" | Reads your calendar and gives you a short brief |
| "Any new email from Sam?" | Searches Gmail and summarizes in a line or two |
| "Reply that I'll be 10 minutes late" | Drafts the reply, **shows it on the lens, sends only after you say yes** |
| "Move my 3 o'clock to 4" | Shows old → new time, moves it after your yes (attendees are notified) |
| "Add lunch with Ana Friday at noon" | Shows the event, adds it after your yes |

Scopes: `calendar.events`, `gmail.readonly`, `gmail.send`. Duet can't delete mail or events.
To disconnect: delete `google.json` and remove Duet at <https://myaccount.google.com/permissions>.
