# Setting up the Google Cloud OAuth client

Google Drive access needs a real OAuth client — Dimension deliberately does
**not** ship a shared one (a shared client would need Google's app-verification
review for the Drive scope, and every user would trust the same credential).
Instead, each user creates their own **free** Google Cloud project, ~5 minutes,
one time. Nothing here is Dimension-specific — this is the standard flow any
installed/desktop OAuth app asks a user to do.

## Steps

1. **Create (or pick) a Google Cloud project.** [console.cloud.google.com](https://console.cloud.google.com/) → project picker (top bar) → **New Project** (any name, e.g. "My Dimension Drive"). Free — no billing account required for this.
2. **Enable the Drive API.** Left nav → **APIs & Services → Library** → search "Google Drive API" → **Enable**.
3. **Configure the OAuth consent screen** (first time only). **APIs & Services → OAuth consent screen** → User type **External** → fill the required app name/support email → **Save**. Leave it in **Testing** status — add your own Google account under **Test users** so you can sign in without Google's review (review is only required to make it public).
4. **Create the OAuth client.** **APIs & Services → Credentials → Create Credentials → OAuth client ID** → Application type **Desktop app** → any name → **Create**.
5. **Copy the Client ID and Client Secret** it shows — paste them into the plugin's Connect form (**Plugins → Google Drive → Set up**).

That's it — no redirect URI to register. "Desktop app" clients accept any
loopback port at connect time (RFC 8252 §7.3), which is what Dimension's
connect flow uses.

## What Dimension does with these values

- The Client ID/Secret are written **only** to `~/.config/dimension-google-drive/token.json`
  on this machine, alongside the OAuth token — never sent anywhere else.
- The actual sign-in opens your system browser (never an embedded webview —
  Google blocks OAuth in embedded browsers for security), you approve the
  `drive.readonly` scope, and the browser redirects back to a local port
  Dimension is listening on.
- Disconnecting the plugin deletes the token file; you'd re-paste the same
  Client ID/Secret to reconnect (they aren't secret-rotated by disconnecting).

## Troubleshooting

- **"Access blocked: this app's request is invalid"** — the OAuth consent
  screen isn't configured, or you're not listed as a test user (step 3).
- **"redirect_uri_mismatch"** — you created a "Web application" client instead
  of "Desktop app" (step 4); Web clients require pre-registered redirect URIs,
  Desktop clients don't.
- **Token refresh fails after a while** — Testing-status consent screens issue
  refresh tokens that expire after 7 days; publish the consent screen (still
  under your own project, no Google review needed unless you request sensitive
  scopes beyond `drive.readonly`) for long-lived tokens.
