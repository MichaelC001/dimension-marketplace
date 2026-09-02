# Message composition with MML

himalaya composes emails with **MML** (MIME Meta Language) — a small XML-like
syntax that compiles to MIME. A message is a list of **headers**, a blank line,
then the **body**.

```
From: you@gmail.com
To: recipient@example.com
Subject: Hello

This is the body.
```

- `From`, `To`, `Cc`, `Bcc`, `Subject`
- `Reply-To` — address for replies if different from `From`
- `In-Reply-To` — message ID being replied to
- `References` — **REQUIRED alongside `In-Reply-To` for correct threading.**
  `himalaya message reply`/`template reply` (interactive/piped-through-editor
  flows) set this correctly. But if you hand-build a raw template (headers +
  MML body as a heredoc/string, then `template send`) — the manual path this
  skill's Safety section describes for confirm-before-send — `References` is
  easy to drop, and Gmail's OWN conversation view folds a reply into its
  thread by matching `References` (not just `In-Reply-To` + subject). Chain
  it: the replied-to message's `References` + its own `Message-Id`, in that
  order, space-separated. Get both with
  `himalaya message read <id> -H References -H Message-Id`.

Address formats:

```
To: user@example.com
To: John Doe <john@example.com>
To: a@example.com, "Jane" <jane@example.com>
```

## Attachments

```
From: you@gmail.com
To: bob@example.com
Subject: With attachment

Here is the document.

<#part filename=/path/to/document.pdf><#/part>
```

Custom display name / multiple files:

```
<#part filename=/path/to/file.pdf name=report.pdf><#/part>
<#part filename=/path/to/doc2.pdf><#/part>
```

## HTML (alternative text + HTML)

```
<#multipart type=alternative>
This is the plain text version.
<#part type=text/html>
<html><body><h1>The HTML version</h1></body></html>
<#/multipart>
```

## Inline image

```
<#multipart type=related>
<#part type=text/html>
<html><body><img src="cid:img1"></body></html>
<#part disposition=inline id=img1 filename=/path/to/image.png><#/part>
<#/multipart>
```

## Mixed (text + attachments)

```
<#multipart type=mixed>
<#part type=text/plain>
Please find the attached files.
<#part filename=/path/to/a.pdf><#/part>
<#part filename=/path/to/b.zip><#/part>
<#/multipart>
```

## MML tag reference

- `<#multipart type=...>` — `alternative` (same content, different formats), `mixed` (text + attachments), `related` (HTML + referenced images).
- `<#part ...>` — `type=<mime>`, `filename=<path>`, `name=<display>`, `disposition=inline`, `id=<cid>`.

## Replying with a hand-built template (threading correctly)

When the flow is "read → confirm content with the user → send" (not an
interactive editor), build the reply as a raw template and pipe it to
`template send`, but get the `Subject`/`References`/`In-Reply-To` from the
ORIGINAL message's raw headers — never retype a subject you read off a
rendered/table view. Two failure modes, both silent (the send succeeds,
threading breaks):

1. **Missing `References`** — see the header list above.
2. **A retyped subject drops non-ASCII characters** — an em/en-dash (`–`/`—`),
   curly quotes, or double spacing in the original subject is easy to
   flatten to a plain `-`/straight quote/single space when copying by eye
   from a terminal table. Gmail's thread-matching is exact-string on the
   (Re:-stripped) subject; a one-character mismatch is enough to fork a new
   conversation. Pull the subject with
   `himalaya message read <id> -H Subject` (not the `envelope list` table,
   which can also truncate/re-wrap it) and reuse it byte-for-byte.

```bash
himalaya message read <id> -H Subject -H Message-Id -H References
```

Then compose:

```
From: me@gmail.com
To: them@example.com
References: <original-references-if-any> <original-message-id>
In-Reply-To: <original-message-id>
Subject: <exact subject from the header read above>

body...
```

`cat template.txt | himalaya template send` sends it; if you want the user to
review first, `... | himalaya template save -f "[Gmail]/Drafts"` instead
(note: Gmail's drafts/trash folders are literally named `[Gmail]/Drafts` and
`[Gmail]/Trash` — `himalaya folder list` first if unsure of the exact names
for this account. Default `himalaya message delete <id>` assumes a folder
named `Trash` and errors on Gmail; `himalaya flag add <id> -f <folder> deleted`
works everywhere as the fallback).

## Composing from the CLI

```bash
himalaya message write                       # opens $EDITOR with a template
himalaya message reply 42                     # quoted reply
himalaya message reply 42 --all               # reply-all
himalaya message forward 42
himalaya message write -H "To:bob@example.com" -H "Subject:Quick" "Body"
cat message.txt | himalaya template send      # send a prepared template
```

Tips: save+exit the editor to send, exit without saving to cancel. Inspect a
received message's raw MIME with `himalaya message export --full`.
