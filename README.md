# cache

A Claude Code plugin that shows how long the prompt cache of the current session stays warm, on the status line above the prompt:

```
cache plugin ◷ 54m
```

When the cache has likely expired it shows `◷ cold`, so you know your next message will re-cache the whole conversation.

## How it knows

There is no API to ask how long the cache has left, so the plugin works it out from the session transcript (`~/.claude/projects/<project>/<session>.jsonl`), the same way the Claude Code VS Code extension's prompt cache indicator does:

- The window starts when the request that used the cache was sent: the last main-thread prompt or tool result before the response.
- Its length is the tier the response wrote: 1 hour when `usage.cache_creation.ephemeral_1h_input_tokens` is above zero (the default on a Claude subscription), 5 minutes when `ephemeral_5m_input_tokens` is (the default on API keys, Bedrock and Vertex).
- After a compaction it shows cold until the next response.

Because it reads the transcript, the time stays right after you close and reopen the app. It refreshes every 15 seconds and after each turn. Nothing leaves your machine.

Inside the VS Code extension, which has its own indicator, the plugin does nothing.

## Install

At the prompt of a Claude Code session:

```
/plugin install cache --marketplace gmarsano/claude-cache-plugin
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin marketplace add gmarsano/claude-cache-plugin
claude plugin install cache@claude-cache-plugin
```

New sessions load it.

## Caveats

It relies on the transcript format and on the `CLAUDE_CODE_ENTRYPOINT` variable the VS Code extension sets. Neither is a documented API, so a Claude Code update may break it.

## License

MIT
