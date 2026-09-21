# Recorded Pi payloads

Seam 2 (adapter conformance) runs the Pi adapter over payloads recorded from a real Pi session:
the `session_before_compact` event exactly as Pi emitted it, with the extension installed. They are
how a change in Pi's shapes shows up as a red test rather than a silent no-op in someone's session.

## What is here

`pi-0.86.1/` — recorded with Pi 0.86.1 against a small throwaway project, real model, real tool calls:

| File | Trigger | What it is |
|---|---|---|
| `manual-first.json` | `/compact` | A first compaction: four turns of reads and a `bash` call. |
| `manual-repeat.json` | `/compact` | The second compaction of that session. Its `previousSummary` is the summary this adapter wrote for the first, and the compaction entry on its branch carries the `EngineDetail` this adapter persisted. |
| `threshold-first.json` | automatic threshold | Pi's own threshold trigger, mid-session, on a session whose compaction threshold was lowered. |

The overflow trigger is not recorded: it needs the provider to reject a request for size. It is the
same event with `reason: "overflow"` and `willRetry: true`, and is exercised in the tests by
overriding those two fields on a recorded payload.

## Re-recording for a new Pi release

1. Make a throwaway directory with a few small source files and a `.pi/settings.json` that lowers
   the compaction thresholds, for example `{ "compaction": { "enabled": true, "keepRecentTokens": 600 } }`.
   For the automatic trigger, also set `reserveTokens` so that `contextWindow - reserveTokens` is a few thousand tokens.
2. Run Pi with only this extension and the tap, and drive a session that reads files and runs a command:

   ```sh
   MASKPOINT_RECORD_DIR=/tmp/recorded pi --no-extensions \
     -e packages/pi/src/extension.ts -e packages/pi/test/recorded/record-extension.ts \
     --no-context-files --no-skills
   ```

   Use `/compact` for the manual payloads, and a second `/compact` after more turns for the repeated one.
3. Replace the throwaway directory's real path with a neutral one (`/workspace/...`) and save the
   payloads under `pi-<version>/`. Nothing else is edited: these are recordings.
4. `npm run check:corpus` must pass. It sanitizes this directory too: no credentials, no real home paths.

The tests derive what they check (which bodies must be gone, which entries were evicted) from the
recording itself, so a re-recorded payload needs no test edits unless Pi's shapes really changed.
