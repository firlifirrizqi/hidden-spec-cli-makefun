# hidden-spec-cli-makefun

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/firlifirrizqi/hidden-spec-cli-makefun/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/firlifirrizqi/hidden-spec-cli-makefun/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool that reads all four formats AI models
write edits in — unified diffs (even with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches and JSON tool calls — and applies them to
a tree of text files, all or nothing. An edit that cannot be placed fails
without touching the tree, and every failure is reported.

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22 and its standard library only; nothing is installed. PATCH is the
patch file, or standard input when it is absent or `-`.

```sh
node main.ts fix.patch            # apply a patch file
node main.ts < fix.patch          # ... or from stdin
node main.ts --format=v4a p.txt   # force one format (auto by default)
node main.ts --check fix.patch    # same output and exit code, writes nothing
node main.ts --strict fix.patch   # match lines exactly (tier 0 only)
```

Exit 0 writes the tree and prints one line per changed path (`A`, `D`, `M`,
`R old -> new`) plus `ok: <n> files`. Exit 1 lists each failed edit plus
`failed: <k> of <n> edits` and writes nothing. Exit 2 is a usage, missing
patch, unknown format or parse error, with exactly one `error: ...` line.

---

Entered on [make.fun](https://make.fun/?ref=v8vnayfm&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
