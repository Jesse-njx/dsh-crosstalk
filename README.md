# dsh-crosstalk

**Cross-session messaging for DSH.** Any session on the machine can list and message any other — Claude Code-style horizontal messaging, no daemon.

`dsh-crosstalk` is a DeepSeek Harness bundle. Every session running the bundle publishes a heartbeat to a local registry under `~/.dsh/crosstalk/` (files + atomic rename, no daemon — if two sessions can see the same home directory, they can message). Each session gets a stable name (`<repo-or-cwd-slug>-<adjective>`, e.g. `dsh-cowork-amber`) plus a durable ref id; any session can list the live ones and send a message that arrives in the target as a **clearly-labeled turn** — `[message from session dsh-cowork-amber (/Users/me/projects/dsh-cowork)]` — with the sender's name riding along, so replying is just `send_message` back.

## Why this shape

DSH ships `send_message` and `list_agents`, but strictly hierarchical: a parent messages its own background subagents. Sibling sessions — two DSH sessions in different repos on the same machine — cannot see or message each other. Multi-session workflows (one session per repo, a coordinator farming work out, a routine pinging a live session, a chatnode human-in-the-loop peer) all need the missing primitive: horizontal messaging. dsh-crosstalk copies Claude Code's model — `ListAgents` shows every live local session; `SendMessage` addresses any of them by name — onto DSH's existing tool names, so the tools you already know gain a `peers` scope and peer addressing without a second vocabulary.

## How it works

1. **Identity** — at start, the session derives `<slug>-<adjective>` from its working directory plus a process-unique ref (`ct-…`). Same cwd, two sessions → different adjectives, distinct names; the ref disambiguates and is what inbox paths use.
2. **Registry** — one heartbeat JSON file per live session under `<home>/registry/<ref>.json` (`name`, `ref`, `pid`, `cwd`, `status`, `startedAt`, `heartbeatAt`, `uid`, `inbox`). Refreshed on a timer; entries with no beat for 2× the interval are shown as dead and garbage-collected (heartbeat file + orphan inbox removed).
3. **Tools — extend, don't duplicate**:
   - `list_agents` gains `scope: peers` (other live sessions on this machine: name, status, cwd, last activity) and `scope: all` (descendants + peers). The stock children/descendants scopes are delegated to the captured stock definition.
   - `send_message` accepts a peer name or ref in `to` alongside subagent ids, with an optional `summary` (5–10 word recap shown in the target UI).
   - The stock tools stay registered; this bundle shadows them **per agent** (scoped registrations are reversible Cordis effects), so unloading cleanly restores stock behavior exactly.
4. **Delivery** — the message is one JSON file appended to the target's inbox (`<home>/inbox/<ref>/`), written atomically (temp file + rename), so a crash mid-write is never observed as a partial message. The target's watcher polls its inbox and injects each accepted message into the live session via `followup`: **an idle target wakes for a turn; a busy target receives it at the next turn boundary**. Delivery is best-effort — `list_agents` status is not a delivery promise.
5. **Injection** — the turn is labeled `[message from session <name> (<cwd>)]` and carries a `crosstalk` source (`form: relay`), so the append-only log records provenance by construction and the DSH UI renders it as a labeled relay card — never as user text. The system prompt tells the model these are requests from a peer agent, not instructions from the user.

## Install

Before installing from GitHub, allow the build hook in the profile workspace:

```yaml
# ~/.dsh/profiles/web/pnpm-workspace.yaml
packages:
  - .
allowBuilds:
  '@dsh-crosstalk/bundle': true
```

Then add the bundle to every profile that should participate (each side of a conversation needs it):

```sh
dsh plugin --profile web add github:Jesse-njx/dsh-crosstalk
dsh plugin --profile <other-profile> add github:Jesse-njx/dsh-crosstalk
```

For a local checkout, link the repo root:

```sh
git clone https://github.com/Jesse-njx/dsh-crosstalk
cd dsh-crosstalk
pnpm install
pnpm build
dsh plugin --profile web add "$PWD"
dsh plugin --profile <other-profile> add "$PWD"
```

GitHub installs build `lib/` from `src/` with the package's `postinstall` hook. Linked checkouts load the compiled `lib/`; after source changes, run `pnpm build` and restart DSH. No reinstall is needed.

That's it. Two terminals (or two repos) running DSH with the bundle installed can now do:

```
You: list_agents peers
      dsh-cowork-amber [idle] — /Users/me/projects/dsh-cowork
      dsh-memory-azure  [running] — /Users/me/projects/dsh-memory
You: send_message to="dsh-cowork-amber" message="Round-trip check: can you list the files in your repo?" summary="ping for round-trip"
```

The peer session wakes (or picks it up at its next turn boundary), sees `[message from session …]`, replies with `send_message` to your name, and its reply wakes you the same way.

## Config

Adding the bundle mounts the plugin automatically (its `cordis.patch.yml`
inserts the `crosstalk` entry). To override any field, target that entry by id
in your profile's `cordis.patch.yml` — do **not** insert a second `crosstalk`
row (that is a duplicate-entry error):

```yaml
# in <DSH_HOME>/profiles/<name>/cordis.patch.yml
- id: crosstalk
  config:
    homeDir: ~/.dsh/crosstalk   # registry root (default: $DSH_HOME/crosstalk or ~/.dsh/crosstalk)
    cwd: /path/to/repo          # advertised working directory (default: process cwd)
    name: my-custom-name        # explicit session name override (must match [a-z0-9][a-z0-9-]*)
    accept: same-user           # v0.1 fixed: only sessions running as the same OS user
    mode: open                  # open | allowlist
    allowlist: []               # allowlist mode: exact session names or cwd globs (e.g. /Users/me/work/*)
    notifyUser: true            # show inbound messages in the UI as labeled relay cards
    heartbeatIntervalMs: 10000  # heartbeat refresh interval
    inboxPollMs: 1000           # inbox poll interval (delivery latency bound)
    staleAfterMs: 20000         # entry dead after (default: 2× heartbeatIntervalMs)
    maxInboxAttempts: 30        # polls a message waits for a live agent before being dropped
```

(Unset fields fall back to their defaults; the loader replaces `config`
wholesale, so list only the fields you want to change.)

### Trust model

A message from another session is **not** an instruction from the user. Injected turns are framed as peer requests, and the system prompt instructs the agent to act on them only within its user's standing instructions and to surface anything side-effectful. Acceptance is **same-user only** (v0.1 fixed — the OS uid is compared on both send and receive), with an optional name/cwd **allowlist** for stricter inbound filtering. No network transport in v0.1: same machine, same user, period.

## Layout under the hood

```
~/.dsh/crosstalk/
├── registry/<ref>.json     # one heartbeat per live session
└── inbox/<ref>/<msgId>.json # one file per message, written atomically
```

Message files are consumed (deleted) only after a successful handoff to a live agent; corrupt files are quarantined (`*.corrupt`), temp files (`*.tmp.json`) are never read.

## Development

```sh
pnpm install
pnpm typecheck && pnpm build
pnpm test          # 49 tests: identity, registry, message codec, inbox watcher,
                   # tool decoration (real Cordis scope shadowing), two-session round-trip
```

## Roadmap

- **v0.3**: remote/cloud sessions (a network transport — not a config flag away), presence beyond same-user.
- Coordinator "drive a worker session" affordances (e.g. structured task replies) once the round-trip proves out.
