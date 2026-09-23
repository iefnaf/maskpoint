# Recall: recovering masked content on demand

Written on 2026-09-23 after a design discussion and three model-in-the-loop experiments on
glm-5.3 (Pi RPC mode, tool-only retrieval harness). It answers one question: **how does the
agent get back what masking removed — without giving anything a model call, a second surface, or
a compaction exemption?**

Work anchor: issue #53.

## 1. The gap this closes

Masking replaces stale tool output (and, optionally, reasoning) with a placeholder that says what
was omitted and how large it was. That is honest, but one-way: the original text still exists in
the session jsonl — append-only, untouched — yet the agent has no way to reach it. If a later turn
needs the exact assertion text, the error code, or the command line from behind a placeholder,
the honest answer today is "gone from context".

Recall closes that loop. It is the inverse of the mask primitive: masking moves content out of
the context, recall moves it back, verbatim, on demand. A placeholder stops being a tombstone
and becomes a door.

```text
at mask time            [tool result omitted: bash, ok, 14 lines, 892 chars (recall id:39f65e5a)]
                                                                    └── session entry id

when the model needs it  tool call: recall({ id: "39f65e5a" })
                              └── reads the session jsonl, returns the entry verbatim
```

## 2. Design decisions (resolved)

Each of these was settled in discussion; the rationale is recorded because getting them wrong
warps everything downstream.

### 2.1 Recall is the inverse of mask, not a retrieval layer

The tool is part of the compaction mechanism, scoped to what masking removed — not a general
session-search product. Three reasons:

- It strengthens the existing promise ("compression without losing detail") instead of opening a
  new front.
- A narrow scope keeps behavior predictable: the model reaches for recall when a placeholder is
  in the way, not as a general habit.
- A generic retrieval layer (search the whole session, cross-session indexes, a memory ledger)
  is a different product and would drag the repo toward heavy infrastructure.

The honest cost: in a session that has never compacted, the tool is useless. That is fine —
nothing is masked, so nothing needs recovering.

### 2.2 The model opens the door, not the user

Agent-facing tool only; no `/maskpoint recall` command in v1. The party missing the information
is the model working in the context, not the operator watching it. The safety case holds because
recall is read-only, side-effect-free, and millisecond-local: the worst outcome of an unnecessary
call is wasted response budget, which the output cap (§4) bounds anyway.

### 2.3 Recovered content is on loan

Recall output is ordinary context with no compaction privilege: the next compaction masks it
again like anything else. The alternative — marking recovered content as sticky and exempt from
masking — would hand the model a permanent exemption to abuse (recall every large output whole)
and break the uniformity that makes masking auditable. If information matters across
compactions, the model's job is to write it to a file or restate it; that is not the compactor's
job. The original never moves in the jsonl, so re-recalling is always possible.

### 2.4 The placeholder is self-describing, and the parameter is `id`

Format: `(recall id:<8-hex>)` appended to every masked stub — observations and reasoning alike
(uniformity beats saving ~350 tokens on the reasoning share). The verb inside the placeholder
must equal the tool name; the experiments (§3) show the pairing, not the word's semantics, is
what the model keys on — but a self-describing verb removes all ambiguity for free.

### 2.5 The tool is named `recall`

`unmask` was proposed for its pairing with the engine's own vocabulary and tested as equivalent
(§3.4). It was rejected on a sharper criterion: **naming must optimize the text the model sees,
not the concept model in our code**. The model never meets the word "mask" — the placeholder
says *omitted*, the tool description says *masked placeholder* once — so `unmask` revokes an
action the model never observed. `recall` matches what actually happens: the original exists and
is being fetched back. It also carries a strong LLM prior from memory/retrieval vocabulary. The
namespace-collision worry (another extension named `recall`) is theoretical: extensions that own
compaction are mutually exclusive in practice.

### 2.6 No system-prompt change, no artifact-preamble lesson

The tool registers through the host's normal tools channel (`pi.registerTool`), so its name and
description ride along with every request — no prompt surgery, which would violate "never worse
than not installed". The artifact preamble does **not** gain an education line: the successful
experiment configuration was exactly tool description + placeholder, with zero failures, so the
extra ~30 tokens per compaction buys nothing measured.

### 2.7 Defensive id parsing

The tool strips a leading `id:` or `e:` from the value before lookup, converting the pollution
failure mode of §3.2 into a success. One line; keeps forgiveness at the boundary.

## 3. Evidence

Method: Pi in RPC mode, a minimal extension registering one retrieval tool backed by an
in-memory store (two entries: a test-failure output, a compiler error), a prompt containing a
compacted-history block with one placeholder, and a task that requires the masked verbatim text.
glm-5.3 throughout. Calls logged server-side for parameter audit. Harness: `/tmp/mp-recall-test/`
(disposable; recreate from this section if needed).

### 3.1 Self-describing placeholder: passes

Placeholder `(recall id:39f65e5a)` → one call, `{"id":"39f65e5a"}` exact, recovered verbatim,
cited with file/line/expected/actual intact, then a sound repair analysis. ~9 s to first
turn end.

### 3.2 Bare anchor: fails by prefix pollution

Placeholder `· e:39f65e5a` → `{"id":"e:39f65e5a"}` — the model copied the parameter hint into
the value. Miss, and **no self-correction**: no retry without the prefix; the model re-ran the
test, found no project in the empty cwd, and honestly declined to fabricate. A format that needs
the model to parse a hint is a format that fails silently.

### 3.3 No anchor: detours

First instinct was `{"id":"","q":"login"}` — keyword search (unimplemented in the harness). This
is the evidence for keeping the `q` parameter: it is the natural fallback for anchors that are
absent (artifacts from before this change) or malformed. The model then recovered the id by
reading the harness's own files (a session-directory reuse leak in that run — disclosed) in
~44 s. Anchors exist to make that path unnecessary.

### 3.4 `unmask` vs `recall`: equivalent

Clean environment (empty cwd, fresh session dir): `unmask` also produced one exact call and a
verbatim citation. Equivalent outcomes settle nothing between the names; §2.5's criterion does.

## 4. Interface

**Stub** (emitted by the engine's mask step, both observation and reasoning placeholders):

```text
[tool result omitted: bash, ok, 14 lines, 892 chars (recall id:39f65e5a)]
```

**Tool schema** (TypeBox, names exact):

```ts
{
  id: Type.Optional(Type.String({ description: "the id shown after 'id:' in a mask placeholder" })),
  q:  Type.Optional(Type.String({ description: "optional substring filter over masked entries without an anchor you know" })),
}
```

**Output contract:**

- Every response is prefaced with the same history-not-instructions framing the compaction
  artifact carries. Recovered content is historical evidence; it must never read as directives.
- Search results are budget-bounded (~4k chars default); a single entry requested by id may use
  `full` mode with a hard cap (~50k chars) and continuation markers that reference the same id —
  recall must never become the context bomb it exists to defuse.
- Scope: entries before the most recent compaction boundary only (post-boundary content is
  already in context). No compaction yet → an explicit "nothing compacted to recover" reply.
- `id` may be a unique tail of the entry id; an ambiguous tail lists the candidates.

## 5. Scope and structure

- `packages/core/src/recall.ts` — pure functions over parsed session entries (parse, by-id,
  search, budgeted render). Host-free and testable like the rest of the engine; other adapters
  get recall later by adding a thin tool shell over the same core.
- `packages/pi/src/tool.ts` — `pi.registerTool` wiring, loads the session jsonl via
  `ctx.sessionManager.getSessionFile()`. v1 reads the file per call (milliseconds at session
  scale); caching is a later optimization if measurement ever demands it.
- v1 hardcodes the budget constants; no new `EngineConfig` keys until a real need shows up.

## 6. Non-goals

- No user-facing command (`/maskpoint recall`) — §2.2.
- No cross-session search (`scope:past`) — v2 material at the earliest.
- No sticky recovered content — §2.3.
- No BM25 or index files — linear substring/regex over a few hundred entries is milliseconds.
- No background workers, ledger, or observational memory — a different product; the comparison
  target is pi-blackhole, whose recall-over-raw-session idea this design borrows deliberately and
  whose memory machinery it declines.

## 7. Security

- Read-only: the tool reads the session file and returns text. No writes, no execution, no side
  effects; a malicious or confused caller cannot mutate anything.
- Injection framing: recovered entries are attacker-influenced text (old tool output can contain
  prompt-injection). The history-not-instructions preface is mandatory on every response.
- Placeholder spoofing: an old message could contain a fake placeholder to bait a recall. The
  worst outcome is a lookup miss or wasted budget; the tool returns only real entries, so the
  bait cannot smuggle new content — it can only redirect attention to something that actually
  happened. Acceptable.

## 8. Acceptance

The experiments validated the model side with a synthetic placeholder and an in-memory store.
Implementation is accepted when the real chain passes end to end: maskpoint compacts a real
session (stub carries anchors) → resume → the model, given a task needing masked content, calls
`recall` with the exact id and receives the verbatim entry from the real session jsonl. Core
unit tests cover parse/by-id/search/budget/render including tail resolution and prefix
forgiveness.

## 9. Open issues (implementation-time)

| Question | Default leaning |
|---|---|
| Exact budget numbers (search default, full-mode cap) | ~4k chars search, ~50k full; constants in core |
| Result rendering metadata (timestamp, tool name per hit) | one header line per hit |
| Paging parameter shape for `full` overflow | continuation marker carries `page` |
| Whether `q` also searches post-boundary entries | no — scope stays §4 |

## 10. Alternatives considered

- **`unmask` as the tool name** — tested equivalent, rejected on the model-visible-text
  criterion (§2.5). The lesson outlives the decision: name for the reader you have.
- **`#N` positional indices** (pi-blackhole's scheme) — indices depend on a rendering format and
  drift across compactions; session entry ids are stable forever in an append-only file.
- **Sticky recovered content** — abusable exemption, breaks masking uniformity (§2.3).
- **A generic retrieval layer with ledger and workers** (pi-blackhole's full architecture) —
  strong where continuous memory matters, but it spends tokens during the session and builds
  infrastructure this engine's promises do not need; borrowed the recall idea, declined the rest.
