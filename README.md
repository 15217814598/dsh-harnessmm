# dsh-harnessmm

HarnessMM ([arXiv 2610.32813](https://arxiv.org/abs/2610.32813)) for DeepSeek Harness:
a bank-aware `terminal` tool that executes decisions the slow turn already made,
instead of paying a new reasoning call per shell command.

The plugin is a direct port of the runtime mechanism shared by
[HarnessMM](https://github.com/YuhuaJiang2002/HarnessMM) (Apache-2.0) and its
[pi extension](https://github.com/jlon/pi-harnessmm) (Apache-2.0):

| Mechanism | Where in this plugin |
| --- | --- |
| `<CHISEL_PLAN>` Executable Decision Graph (EDG) | `bank.js`, the `chisel_plan` argument channel |
| Guarded Decision Reuse (GDR) | `guard.js`, `admission.js`, `controller.js` |
| Certified Callback Substitution (CCS) | `certified-native-substitution/v1` certificates in `controller.js` |
| Authoring instruction / selector prompts | `policy.js` |
| Compact selector state and one-character judge | `admission.js`, `selector.js` |
| Priors-based admission (policy v8/v10) | `admission.js` (`admit`, `actionType`) |

## What it does

One slow model turn authors a **literal action bank** together with one root
command. The `terminal` tool runs the root, then walks the bank: every successor
whose guard holds on the **immediately preceding native receipt** executes
through the same shell interface without another model call, and each execution
is certified as one bypassed reasoning callback.

```text
model turn N ── <CHISEL_PLAN> A→B→C  +  root command
                 ├─ root executes ──────────────► receipt
                 ├─ A: guard(return_code==0) holds ──► receipt   (no model call)
                 ├─ B: guard(stdout_contains="PASS") holds ──► receipt   (no model call)
                 └─ C: bank exhausted ─────────────────► slow actor resumes
```

## Install

The plugin is a profile bundle with no dependencies and no build step:

```text
plugin_manager  action: install_bundle  target: E:\project\dsh-plugin\dsh-harnessmm
```

The bundle patch inserts one row (`harnessmm`) with the default configuration.
Changes activate immediately in the profile; a package replacement needs a
restart to load the new module generation.

## The tool

`terminal` is registered next to the harness's own shell tool and dispatches
**every** command through it (`pwsh` on the Windows preset, `bash` on POSIX).
That keeps the tool registry's pre-execute policy, the session's sandbox policy,
approvals, cancellation and job handling in force for the root **and** each
banked action. The plugin never spawns a process itself.

Arguments:

| Argument | Meaning |
| --- | --- |
| `command` | Root command (required) |
| `cwd` | Working directory; defaults to the session workspace |
| `timeout_sec` | Kill the command after this many seconds |
| `chisel_plan` | Optional literal action bank (array of candidate nodes) |

The receipt of every command is `{return_code, stdout, stderr}`. Non-zero exits
are reported, not treated as tool failures. The model sees clipped streams; the
guards and certificates see the exact native receipt.

## Use it

**Normal use needs no special syntax.** The plugin's prompt section tells the
model to author a bank whenever it can already name the next dependent commands,
so you keep working as usual and the tool result starts with a line like
`harnessmm: completed; 3 substitution(s) certified`.

**Force a first test** by naming the tool and the plan explicitly:

```text
Use the `terminal` tool (not pwsh) with a `chisel_plan`: run `echo root-ok` as
the root, then `echo A-ok`, then `echo B-ok` whose guard requires stdout to
contain "A-ok". Then quote the harnessmm line you got back.
```

Expected result — one tool call, three receipts, two certified substitutions:

```text
harnessmm: completed; 2 substitution(s) certified
bank: 2 candidate(s) from argument (graph …)
receipts:
root {"return_code":0,"stdout":"root-ok…","stderr":null}
A {"return_code":0,"stdout":"A-ok…","stderr":null}
B {"return_code":0,"stdout":"B-ok…","stderr":null}
```

Ask for the text channel instead with: *"write exactly one `<CHISEL_PLAN>` block
in your message text, then call `terminal` without `chisel_plan`."*

Audit surfaces:

- `/harnessmm` in the composer — counters for this session (`/harnessmm clear` resets).
- `/api/dsh-harnessmm` — the ledger dashboard (open it in the browser already
  signed in to this GUI; the Host's HTTP routes require the GUI's auth).
- `/api/dsh-harnessmm/status` and `/api/dsh-harnessmm/ledger?sessionId=…` — JSON.

## Verify it

### Offline: no model, no harness boot

```bash
cd dsh-harnessmm
node scripts/selftest.mjs      # 11 end-to-end checks, prints the model-facing report
node --test test/*.test.mjs    # 51 unit/integration tests
```

`selftest.mjs` runs the real orchestration (`tools.js` → `bank.js` → `guard.js` →
`admission.js` → `controller.js`) over a fake tool registry and a fake live
session, and asserts:

| Check | What it proves |
| --- | --- |
| text bank: chain executed | a text-authored bank runs A→B and reports `completed` |
| one certificate per successor | CCS records exactly one `certified-native-substitution/v1` per execution |
| certificate names the bypassed callback | `…:omitted:2` and `slow_requests_at_boundary: 0` |
| argument channel without a session log | `chisel_plan` works even when the session log is unavailable |
| false guard | control returns to the model, nothing is executed |
| invalid bank | the root still runs and the contract violation is reported |
| selector | a two-eligible bank is decided by the judge, usage is metered |
| report | the model-facing text names outcome, bank and receipts |
| clipping | the model sees a bounded tail while guards read the exact receipt |

### Live: in the running GUI

1. Send the *force a first test* prompt above. The tool card should show the
   three receipts and the `harnessmm:` line.
2. Run `/harnessmm` — `banks authored` and `certified substitutions` increase.
3. Open the **Savings** tab (right of Fleet) and confirm the certificate rows
   for the session; the same-origin `/api/dsh-harnessmm` page is the equivalent
   HTML fallback.
4. Prove a model call was actually skipped: one assistant step produced receipts
   for `root`, `A` and `B`, and each certificate carries
   `bypassed_slow_callback_id: "<authoring call>:omitted:N"` with
   `slow_requests_at_boundary: 0`.

### Negative cases (the mechanism fails closed)

| Try | Expected |
| --- | --- |
| candidate repeats the root command | `bank rejected: A future candidate cannot repeat…`, outcome `invalid_bank`, root still ran |
| guard uses a marker that never appears | outcome `deferred`, `control returned to the model: no_eligible_or_unexpected_receipt` |
| argument contains `${VAR}` | rejected as an unresolved placeholder |
| guard names `task_solved` / `code_correct` | rejected: guards are receipt-local |
| two successors both eligible | the judge picks one label (selector tokens > 0) or abstains back to the model |
| non-zero exit anywhere in the chain | chain stops, last receipt reports the exit code, outcome `failed` |

## The authoring contract

The bank travels in exactly one channel per turn: the `chisel_plan` argument, or
one `<CHISEL_PLAN>{"candidates":[...]}</CHISEL_PLAN>` block in the same assistant
text. A turn that declares both is a contract violation.

```json
{
  "candidates": [
    {
      "candidate_id": "A",
      "predecessor_id": "root",
      "tool": "terminal",
      "arguments": { "command": "npm run build" },
      "guard": { "return_code": 0 },
      "required_receipt_fields": ["return_code"],
      "expected_local_cost": { "selector_upper_tokens": 2048 },
      "dependency_ids": []
    },
    {
      "candidate_id": "B",
      "predecessor_id": "A",
      "tool": "terminal",
      "arguments": { "command": "npm test" },
      "guard": { "return_code": 0, "stdout_contains": "PASS" },
      "required_receipt_fields": ["return_code", "stdout"],
      "expected_local_cost": { "selector_upper_tokens": 2048 },
      "dependency_ids": ["A"]
    }
  ]
}
```

Rules enforced by `bank.js`:

- `candidate_id` is a unique single letter `A..P`; `predecessor_id` is `"root"`
  or an earlier id; `dependency_ids` may only name `"root"` or already declared ids.
- Node keys are closed. Live guard keys are limited to `return_code`,
  `stdout_contains`, `stdout_equals`, `stderr_empty`, `json_equals`.
- Every guard field must be listed in `required_receipt_fields`, because a guard
  may never read a field the receipt can omit.
- `arguments` must be fully literal `{command, cwd?, timeout_sec?}`; `${...}` and
  `{{...}}` placeholders are rejected, as is repeating the already executed root.
- Exactly one bank and exactly one root tool call per turn; at most
  `maximum_candidates` nodes.

## Admission

| Policy version | Admission |
| --- | --- |
| 6 | deterministic net-saving threshold (`net > 1024`); a single eligible candidate commits with no selector |
| 7 | deterministic admission without the net-saving threshold |
| 8, 10 | priors-based: a frozen TRAIN category median must exist, and the fast path must stay under a quarter of it; **fails closed** without priors |

The saving estimate is the authoring turn's recorded `usage.totalTokens`. When
the session log is unavailable the threshold is skipped rather than rejecting
every candidate (the ledger records the estimate identity).

When more than one candidate is eligible, a one-character selector asks **the
same provider/model that authored the bank** for one label. The reply must be a
lone label (trailing punctuation allowed); anything else abstains and control
returns to the model. The selector prompt and compact state are the upstream ones.

## Certificates and ledger

Every substitution records `certified-native-substitution/v1`:

```json
{
  "schema": "certified-native-substitution/v1",
  "bank_sha256": "...", "candidate_id": "B",
  "bypassed_slow_callback_id": "call_abc:omitted:2",
  "predecessor_callback_id": "chisel_..._A",
  "graph_hash": "...",
  "exact_native_tool": "terminal",
  "exact_arguments": { "command": "npm test" },
  "native_receipt_hash": "...", "native_receipt": { "return_code": 0, "stdout": "...", "stderr": null },
  "guard": { "return_code": 0, "stdout_contains": "PASS" },
  "native_action_hash": "...",
  "slow_requests_at_boundary": 0,
  "slow_sequence_before": 0, "slow_sequence_after": 0,
  "valid_substitution": true
}
```

The certificate binds the exact arguments, the exact receipt and the absence of
an intervening slow request. It never claims task correctness or counterfactual
tokens.

Surfaces:

- In-app UI (web client): a **Savings** tab in the session tab strip, right of
  the Fleet tab — the four savings cards (net included), this session's and the
  profile-wide estimated saving, a **session picker grouped by project**, one
  row per certificate (command, guard, exact receipt, proxy saving) and the raw
  event stream. It registers as a `conversation.view` list item (`order: 40`;
  Fleet is 30) and reads the same-origin `/api/dsh-harnessmm/*` routes.
- The picker groups sessions by their **project** (the session header's `cwd`)
  and shows each project's cumulative saving; every certificate still belongs to
  the session that produced it — project is a view, not the accounting unit.
- `/harnessmm` — counters for the current session, plus the estimated saving
  (`/harnessmm clear` resets it).
- `GET /api/dsh-harnessmm/status` — policy, tool, shell target, per-session
  counters (`estimated_saved_tokens` included).
- `GET /api/dsh-harnessmm/ledger?sessionId=…` — every retained event plus the
  per-substitution savings rows (`substitutions`).
- `DELETE /api/dsh-harnessmm/ledger[?sessionId=…]` — clear one session or all.
- `GET /api/dsh-harnessmm` — the same-origin HTML savings dashboard (the
  fallback when the client bundle is not loaded).

The savings estimate is a visible proxy, never a counterfactual claim: each
substitution saves the authoring turn's `usage.totalTokens` minus the selector
spend attributed to it (`estimated_saved_tokens`); selector spend that produced
a fallback is counted in `selector_tokens_lost` and never as saved. Without a
session log the slow tokens are 0, so the estimate is 0.

The ledger persists to `$DSH_HOME/storages/harnessmm/ledger.jsonl` by default
(`~/.dsh/storages/harnessmm/ledger.jsonl`; JSONL, one event per line) and is
rehydrated at boot, so earlier sessions remain selectable in the Savings tab. It
stores certificates (command, guard, receipt excerpt, saved tokens), which
therefore reach local disk; `persist: false` keeps the ledger memory-only. Turns
from before the plugin was enabled cannot be backfilled — certificates are
runtime facts, not an after-the-fact estimate.

## Configuration

```yaml
- insert:
    - id: harnessmm
      name: 'dsh-harnessmm-plugin'
      config:
        enabled: true
        policy:
          version: 6
          maximum_candidates: 16
          maximum_fast_steps: 8
          maximum_public_bytes: 65536
        shellTool: ''          # '' = pwsh → bash → shell
        maxReceiptBytes: 8192  # per stream, model-visible
        selector:
          enabled: true
          maxTokens: 256       # reasoning models need a few tokens before the label
          temperature: 0
        persist: true          # mirror the ledger to local JSONL
        storagePath: ''        # '' = $DSH_HOME/storages/harnessmm/ledger.jsonl
        priors: null           # required by versions 8 and 10
```

Every key is closed and validated at load. `priors` takes the frozen TRAIN table
`{phase: 'train', categories: {inspect: {phase: 'train', median_tokens: 12000}}}`.

## Deviations from the reference

These are deliberate, and each is visible in the code and tests:

1. **Two channels, one bank.** The `<CHISEL_PLAN>` text channel and the v10
   `chisel_plan` argument channel are both supported; declaring both in one turn
   is rejected.
2. **The node-shaped contract only.** Versions 6, 7, 8 and 10 are accepted;
   the pre-v6 `{label, after, condition}` shape is not.
3. **The net-saving threshold needs recorded slow usage.** Without a session
   log the threshold is skipped and the ledger says so; it never silently
   rejects every candidate.
4. **The priors quarter rule is applied.** The reference controller passes
   `fullSAR = version === 6`, which disables the quarter rule it documents for
   v8/v10; this plugin applies the documented rule.
5. **Banks stay in the transcript.** HarnessMM's public-history compaction
   (`compactSession`) is not performed: dsh's surface rewrite belongs to its
   compaction service, and rewriting a message mid-step from a tool execution is
   not a safe operation. The token cost of an authored bank is therefore still
   paid on later turns; every substitution still removes its reasoning callback.
6. **Native dispatch, not a private process.** Every command goes through a
   registered dsh shell tool, so approvals and sandboxing apply to banked actions
   too.
7. **The selector has no logprobs.** Reply shape is verified, exactly as in the
   pi port, but the judge gets a small token budget instead of one token because
   a reasoning model spends tokens before its one-character answer. A lone label
   (optionally with trailing punctuation) is accepted; any prose abstains.

## Development

```bash
cd dsh-harnessmm
node --check index.js client.js bank.js guard.js admission.js controller.js receipt.js session.js ledger.js shell.js tools.js routes.js store.js selector.js policy.js
node --test test/*.mjs
```

The tests exercise the real orchestration against a fake tool registry and a
fake live session; no harness boot or model call is required.
`test/client.test.mjs` proves the client module's registration contract against
a stubbed ModuleLoader and a stubbed React.

After editing `client.js` the host needs a restart to serve the new generation:
the `./client` export path is the browser module identity. To hand an open page
a fresh generation without a restart, save the new version as `client.v2.js`
and update the package.json export.

The `id` in `__ModuleLoader__.load({ id })` **must equal package.json's `name`**.
The loader keys factories by package; a mismatched id makes it treat the row as
still missing, re-execute the bundle through its single-resource URL, and fail
the whole web boot on `duplicate factory registration`
(`test/client.test.mjs` guards against a regression).

## License

Apache-2.0. See [NOTICE](NOTICE) for the upstream attribution.
