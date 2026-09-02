---
alwaysApply: true
description: YouTube connector context
---

You have access to the **youtube** skill — native, always-on tools over the
connected Google account's YouTube (no CLI, no MCP server): `youtube_search`,
`youtube_get_video`, `youtube_list_playlists`, `youtube_list_playlist_items`,
`youtube_playlist_add`, `youtube_list_comments`, `youtube_post_comment`,
`youtube_get_captions`, `youtube_channel_stats`.

- **Confirm before writing.** `youtube_playlist_add` and `youtube_post_comment`
  are mutating. A comment is **public** under the user's real identity — state
  the exact target and the full text and get the user's go-ahead before posting.
- **Resolve ids, don't guess.** Use `youtube_search` /
  `youtube_list_playlists` to turn titles/names into ids before acting; adding to
  the wrong playlist or replying to the wrong comment is the common mistake.
- **Reply vs. top-level comment.** `youtube_post_comment` takes EITHER `videoId`
  (new top-level comment) OR `parentCommentId` (reply to an existing comment from
  `youtube_list_comments`) — exactly one.
- **Transcripts are limited.** `youtube_get_captions` lists caption TRACKS only;
  the official API does NOT let you download the transcript text of a video the
  user doesn't own. If asked for such a transcript, say it's unavailable via the
  official API — never fabricate one.
- **Mind the quota.** `youtube_search` costs 100 quota units (most calls cost 1);
  keep `limit` tight and prefer per-id `youtube_get_video`/`youtube_channel_stats`
  calls (1 unit each) over repeated searches. A `quotaExceeded` error means the
  project is out for the day.
- If a call errors "isn't connected yet" or the token is rejected, the user
  needs to (re)authorize — point them at **Plugins → YouTube → Reconnect**. It
  reuses the same Google Cloud OAuth client as Google Drive/Calendar; the only
  extra step is enabling the **YouTube Data API v3** in that project.
