# PLAN — Cash-flow gaps: the bill the app already knows, and the savings that already close the shortfall

**Type**: targeted amendment to Phase 16 ([PLAN16.md](PLAN16.md)) — not a phase.
**Found by**: the owner, reading `/plan/cashflow` against their own book.
**Blast radius**: one nullable column + one CHECK extension + one partial index;
two new pure modules; one new query; three call sites
([loader.ts](../../src/lib/cashflow/loader.ts),
[review/page.tsx](../../src/app/plan/cashflow/review/page.tsx),
[cashflow/page.tsx](../../src/app/plan/cashflow/page.tsx)); one alert severity.
**No new table, no new worker job, no new dependency.**

> Two complaints, one sentence each:
>
> 1. ***"It's missing my mortgage — which should be auto calculated/figured out."***
> 2. ***"Instead of listing the shortfall, if the user has a savings account that
>    can transfer in funds, shouldn't it show that advice? The user won't let
>    themselves run out of money if the cash flow can be solved by taking from
>    savings."***
>
> Both are Phase 16 defects. Phase 17's surface — *"Your net worth rose
> $1,228,460.40 over this window. See what drove it →"* — is behaving; it was
> simply the screen the complaint was noticed on.
>
> The deliverable is two sentences the page cannot say today:
> ***"Your mortgage, $2,096 on the 1st, is on this line because you told the app
> the loan terms — not because it recognized the bank text."***
> ***"Your savings covers this. Moving $3,030.33 in before October 22 keeps you
> above zero and leaves $14,400 in reserve."***

---

## 1. The diagnosis: the totals are right, the DATES are wrong

This is the single most important paragraph in the plan, and it is the one that
decides how big the fix is.

An unconfirmed mortgage payment **is not missing from the projection**. It is a
transaction like any other, so it sits inside trailing observed spend, so it
sits inside the residual daily rate ([residual.ts](../../src/lib/cashflow/residual.ts))
and is spread **flat across all 60 days** as *"Everyday spending"*. The
household's money is all accounted for. What is wrong is that $2,096 which
actually leaves on the 1st is being charged at ~$70/day for two months.

That is exactly what the screenshot's own caveat reports — ***"15% of your
recent spending is bills this calendar knows about"*** — and it is why the blue
line has no cliff on the 1st and slopes instead. **The consequence is that the
low-water DATE is wrong**, and the low-water date is the entire product of this
page: `min(closing) − floor` is computed from it
([safe-to-spend.ts](../../src/lib/cashflow/safe-to-spend.ts)), the shortfall
alert is deduped on its month ([alerts.ts](../../src/lib/cashflow/alerts.ts)),
and "October 22" is the one thing on the screen a family plans around.

**So neither fix is about finding missing money.** CF-A re-dates money the line
already contains. CF-B re-describes a shortfall the line already computed. Any
task in this plan that starts adding or subtracting a total is a task that has
misread this section.

### 1.1 Why the mortgage in particular never arrives

The calendar has exactly two doors, and the mortgage fits neither well:

| Door | Mechanism | Why the mortgage misses it |
|---|---|---|
| **Detected** | Group `depository` / `credit_card` transactions by `(account, payeeKey, direction)`, require ≥3 occurrences with a rhythm, rank, then **wait for the user to click confirm** (ADR-036 §2) — [candidate-loader.ts:59](../../src/lib/cashflow/candidate-loader.ts#L59), [detect.ts](../../src/lib/cashflow/detect.ts), [periodicity.ts:128](../../src/lib/cashflow/periodicity.ts#L128) | It is proposed only after three payments are imported, only if the servicer's descriptor normalizes stably, and only if the user then finds and confirms it in a list ranked with everything else. Three chances to not happen. |
| **Manual** | The user types label, amount, cadence, anchor date (P16-25) | Asks the household to hand-copy figures the app is already holding one table away. |

And here is the part that makes it a design defect rather than a missing
feature: **the app already knows this mortgage exactly.** The `loan` account
carries a [`liabilities`](../../src/db/schema/liabilities.ts) row —
`principal_at_origination`, `annual_rate`, `term_months`, `start_date` — and
[`monthlyPayment()`](../../src/lib/mortgage/amortization.ts#L44) computes the
payment in closed form. [debt-terms.ts:211](../../src/lib/advice/debt-terms.ts#L211)
**already calls it** to get the minimum payment for the advice engine.

The one bill in the household whose schedule was *stated by the user* is the
only bill the calendar can learn about solely by *guessing from bank text*.

### 1.2 Why "you're short" is the wrong last word

[page.tsx:218](../../src/app/plan/cashflow/page.tsx#L218) closes the shortfall
branch with static copy — *"Moving a bill, or moving money in before then, is
what closes it."* It **names the fix without checking whether the household can
perform it**, which is the difference between advice and a slogan.

The projection walks operating cash only, and that is correct and stays correct
(ADR-038 §6, [queries.ts:321](../../src/lib/cashflow/queries.ts#L321)): a line
that silently drew on savings would stop being able to tell you that you are
overspending. But [`classifyCashTiers`](../../src/lib/advice/cash-tiers.ts)
already computes the reserve balance from the same accounts, and the page never
asks it anything.

The valuable output is not the suggestion. It is the **classification**: a
shortfall the reserve covers is a *timing* problem; one it does not cover is a
*solvency* problem. Those are different sentences, different next actions, and —
per CF-B4 — different alert severities.

---

## 2. What already exists (extend these; rebuild none of them)

- **The obligation model** — [scheduled-obligations.ts](../../src/db/schema/scheduled-obligations.ts):
  `source ∈ ('detected','manual')` as text+CHECK (ADR-037 §7), `detection_key`
  with a **partial** UNIQUE on `(account_id, detection_key)`, `amount_mode ∈
  ('fixed','trailing_median')`, `direction` carrying the sign,
  `active` for deactivate-don't-delete.
- **The matcher** — [match.ts:249](../../src/lib/cashflow/match.ts#L249): an
  occurrence with a `payeeKey` matches on `(account, payee, window, amount)`;
  one **without** matches on `(account, direction, window, amount)`. This
  fallback is what makes CF-A's `detection_key IS NULL` decision workable, and
  §3 turns on it.
- **The residual** — [residual.ts](../../src/lib/cashflow/residual.ts): the rate
  is observed spend **minus spend attributable to matched occurrences**. An
  obligation that never matches is charged twice. This is ADR-038 §2 and it is
  the constraint that sizes CF-A2.
- **Loan math** — [amortization.ts](../../src/lib/mortgage/amortization.ts):
  `monthlyPayment`, `balanceAtMonth`. Already the advice layer's source for the
  minimum payment; this plan makes it the calendar's source for the schedule.
- **Cash tiers** — [cash-tiers.ts](../../src/lib/advice/cash-tiers.ts):
  `tierForSubtype` (the one classifier; `NULL` ⇒ `unclassified`, never guessed)
  and `classifyCashTiers`. `listOperatingBalances` already routes through the
  former, so CF-B's reserve query is a sibling, not a second opinion.
- **The degradation ladder** — [status.ts](../../src/lib/cashflow/status.ts):
  four named rungs, each naming the input that unblocks the next.
  `unclassified` subtypes are already handled honestly there, which is why CF-B
  gets its "we don't know where your cash sits" branch for free.
- **The review surface** — [review/page.tsx](../../src/app/plan/cashflow/review/page.tsx),
  [review/actions.ts](../../src/app/plan/cashflow/review/actions.ts),
  [obligation-manager.tsx](../../src/app/plan/cashflow/review/obligation-manager.tsx):
  the confirm / edit / dismiss / snooze flow. CF-A adds a candidate **source**,
  not a second review page.
- **Naming hazards, checked before naming anything.** `coverage` already means
  *the share of trailing spend the calendar accounts for* — the 15% in the
  screenshot. **Do not name anything in this plan `coverage`.** `reserve`
  already means the cash tier and is used here in exactly that sense. The new
  modules are `liability-obligations.ts` and `shortfall-close.ts`.

---

## 3. ADR-047 — A stated loan schedule is a first-class obligation candidate: `source='liability'`, `detection_key IS NULL`, and the amount comes from the bank when the bank has spoken

**Status**: proposed — CF-00 is the gate.
**Numbering**: `IDEAS.md` §11 currently ends at **ADR-042**. [PLAN18.md](PLAN18.md)
proposes 043–046 and is not yet locked, so this plan takes **047/048** to avoid
a collision whichever lands first. **Verify the max before appending.**

**Context**: §1.1. The household typed its loan terms into the app; the app
computes the payment for the advice engine; the calendar still waits to
recognize the payment in bank text and then asks the user to confirm what they
already told it. Meanwhile the payment is the largest single line in the
household's month, so the date it is missing from is the date the whole page
exists to state.

**Decision**:

1. **A `liability` row with an active `loan` account produces an obligation
   CANDIDATE, not an obligation.** ADR-036 §2 — *confirm, never infer* — is not
   weakened, softened, or excepted. It is **satisfied more cheaply**: the
   candidate arrives pre-filled and correct rather than reverse-engineered from
   three months of descriptors, and the user still clicks confirm. Nothing
   writes `scheduled_obligations` without that click.
2. **The candidate is ranked first on the review page**, above every detected
   one, under its own heading. Not a ranking tweak — a stated schedule and a
   guessed one are different *kinds* of proposal, and mixing them would make the
   user grade a fact as if it were a heuristic. It carries `confidence: null`
   for the same reason: nothing was guessed, so nothing is graded.
3. **`OBLIGATION_SOURCES` gains `'liability'`.** Text + CHECK, extended by
   migration (ADR-037 §7). `source` is provenance and there are now genuinely
   three provenances.
4. **The link is a new nullable `liability_id` FK on `scheduled_obligations`,
   NOT an overloaded `detection_key`.** This is the load-bearing decision.
   `detection_key` is a `payeeKey`, and the matcher **matches on it**
   ([match.ts:315](../../src/lib/cashflow/match.ts#L315)). A key like
   `liability:<uuid>` would match no transaction ever, the occurrence would go
   unmatched, and the residual would keep the mortgage in the flat rate **while
   the calendar also dated it** — the exact ADR-038 §2 double-count, reintroduced
   by a door ADR-038 did not think to close. Left NULL, the matcher falls back
   to `(account, direction, window, amount)`, which is what pairs the occurrence
   to the real payment. `ON DELETE SET NULL`: deleting a liability must not
   delete the schedule that explains the household's month.
5. **Suppression rides on a partial UNIQUE `(liability_id)` WHERE
   `liability_id IS NOT NULL`** — the same shape and the same reason as the
   `detection_key` index. One loan, one confirmed obligation; unlimited manual
   rows stay legal. Dismissal reuses `recommendation_dismissals` under the
   existing `obligation_candidate` rule id with subject key
   `"liability <liabilityId>"`, so snooze/dismiss works with no new table.
6. **The proposed amount prefers OBSERVED payments over computed P&I, and this
   is a correctness decision, not a nicety.** `monthlyPayment()` returns
   principal-and-interest. A real escrowed mortgage payment is materially
   larger. The matcher's tolerance on a `fixed` obligation is ±15%; a P&I
   expectation against an escrow-inflated actual can clear that band, and when
   it does the occurrence is marked **missed** — which raises a false
   *"A bill did not post"* alert **and** leaves the payment in the residual
   while the calendar dates it. So:
   - ≥2 matching outflows to the servicer in the trailing window ⇒
     `amount_mode='trailing_median'`, seeded with their median.
   - Otherwise ⇒ `amount_mode='fixed'` seeded with `monthlyPayment()`, and the
     review UI states plainly that escrow and PMI are not included.
   - The candidate's evidence panel shows **both** figures side by side
     (*"$2,096 observed · $1,730 principal & interest"*), because the gap
     between them is the household's escrow and is worth seeing once.
7. **Cadence is `monthly`; the anchor is observed-then-stated.** The schema
   amortizes in `term_months`, so a loan is monthly by construction. The anchor
   date is the most recent observed payment's day-of-month when one exists, else
   `liabilities.start_date`'s. `end_date` is left NULL rather than computed from
   the term: a household that refinances or overpays would otherwise find its
   calendar quietly ending on a date nobody chose.
8. **The account is the account the money LEAVES, and it is never guessed.**
   `scheduled_obligations.account_id` is the operating account, not the loan
   account. It is inferred only when observed payments identify exactly one
   operating account; with zero or several, the candidate renders with an
   account **selector** and cannot be confirmed until one is chosen. A guessed
   account would attach the household's largest bill to the wrong balance.
9. **This is not mortgage-specific.** Every `loan` account with a `liabilities`
   row proposes — auto loans, student loans. The word "mortgage" appears in no
   identifier this plan adds.
10. **Nothing is auto-confirmed on the user's behalf, ever — including on
    upgrade.** Existing households see a new candidate, not a new bill.

**Consequences**:
- ✅ The largest bill in the month lands on its real date, and coverage (the 15%)
  rises by the largest single step available to this household.
- ✅ The double-count is prevented structurally, by leaving `detection_key`
  NULL, rather than by a rule someone must remember.
- ✅ Provenance stays honest: `source='liability'` says the schedule came from
  stated terms, which is a stronger claim than `detected` and a different one
  from `manual`.
- ⚠️ **Escrow drift is narrowed, not closed** — the same limitation ADR-038
  already documents for `trailing_median`. An annual escrow re-analysis moves
  the payment and the existing `obligation_amount_changed` alert reports it,
  which is the correct amount of machinery.
- ⚠️ A household that pays its mortgage from an untracked account gets a
  candidate it should dismiss. Dismissal is one click and is already built.
- ⚠️ **A double-entry is possible**: a detected series for the same payment
  could be confirmed alongside the liability candidate. Not preventable by
  structure (two legitimately different rows), so CF-A5 handles it by
  disclosure — a collision warning at confirm time, the same posture ADR-045 §4
  takes in PLAN18.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Auto-create the `scheduled_obligation` on liability save | Breaks ADR-036 §2 for the one bill where being wrong is most expensive, and would write rows into existing households' calendars on upgrade with no click anywhere. |
| Put `liability:<uuid>` in `detection_key` | The matcher matches on that column. Guarantees a permanently unmatched occurrence: the mortgage is dated **and** left in the residual — ADR-038 §2's double-count, arriving through a new door. |
| Synthesize obligations at read time, storing nothing | The occurrence table is the substrate for matching, miss alerts and amount-drift alerts. A phantom obligation can be matched to nothing, so the residual subtraction stays wrong — and the residual is the whole point. |
| Use `monthlyPayment()` unconditionally | Ignores escrow. Produces false `obligation_missed` alerts on a correctly-paid mortgage, and the ±15% matcher band makes that likely rather than theoretical. |
| Teach the detector to special-case loan payees | A second notion of "same merchant", which [payee-key.ts](../../src/lib/cashflow/payee-key.ts) exists specifically to prevent, in exchange for a guess where a stated fact is available. |
| Derive the whole schedule from the amortization table (every future payment) | The calendar wants a cadence, not 360 rows. `end_date` NULL plus monthly expansion is the same information without a materialization cliff. |

---

## 4. ADR-048 — A shortfall is classified against reserve cash before it is reported: covered shortfalls are a timing statement, not an alarm

**Status**: proposed — CF-00 is the gate.

**Context**: §1.2. The page computes a shortfall, prints it in red, and closes
with generic advice about moving money — without knowing whether there is money
to move. For a household with a funded emergency fund this over-alarms; for one
without, the same red number under-states a real solvency problem. One display
serving two opposite situations is the defect.

**Decision**:

1. **`classifyShortfall()` is pure, lives in
   `src/lib/cashflow/shortfall-close.ts`, and returns a discriminated union** —
   `covered` | `partly_covered` | `uncovered` | `reserve_unknown`. A union, not
   a boolean plus a nullable amount: the four cases have four different
   sentences, and a boolean would let a caller render three of them wrong.
2. **The projection itself is UNCHANGED.** No reserve balance enters the walk,
   the low-water mark, or safe-to-spend. ADR-038 §6 stands exactly as written:
   the line shows what operating cash does, and a line that quietly absorbed
   savings could never tell a household it is overspending. This ADR adds a
   **second sentence about the same number**, never a second number.
3. **`reserve_unknown` is the honest answer when subtypes are NULL**, routed
   through the one `tierForSubtype`. It renders as the ladder's existing
   "classify your accounts" fix, linked to `/accounts`. Unclassified cash is
   never counted as reserve — ADR-033 §1's rule, restated because this is
   precisely where someone would be tempted to break it.
4. **The alert is graded by the classification, not silenced by it**
   ([alerts.ts](../../src/lib/cashflow/alerts.ts)): `uncovered` keeps today's
   `critical`/`warning` split; `covered` drops to `info`. Never suppressed
   entirely — a household draining its emergency fund every month to make
   payroll is a real finding, and it is the one the monthly repetition of an
   `info` alert states correctly. The dedup key is untouched.
5. **The page states no emergency-fund TARGET.** It says what the reserve is,
   what the shortfall is, and what remains after the transfer — then links to
   `/plan` for whether that is enough. The emergency-fund rule's own header
   gives the reason: *"two implementations of 'how many months' is two numbers
   that can disagree on one screen."* `reserveMonthsFor()` needs a full
   `AdviceInput`, and building one inside a page whose budget is a fast render
   is how the second implementation gets written. Recorded as Open Item 8.2.
6. **No transfer is initiated, offered, or simulated.** This app is read-only
   (CLAUDE.md §Domain Scope) and this is one derived sentence. No "move money"
   button, no scheduled transfer, no partition of a real balance into virtual
   parts — the same line PLAN18's ADR-043 §3 draws, drawn again here because
   this feature sits nearer to it than that one does.
7. **Every figure through `Money`.** `remainingAfterTransfer = reserve −
   shortfall`, clamped at zero and reported alongside `partly_covered` rather
   than allowed to go negative.

**Consequences**:
- ✅ The red number keeps its urgency for the households that need it and stops
  crying wolf at the ones that do not.
- ✅ Uses one shipped classifier and one shipped tier rollup; adds no second
  opinion about what "savings" means.
- ⚠️ A household with reserve cash at an institution the app does not track
  reads `uncovered`. Correct — the app states what it knows — and the standard
  "add the account" path fixes it.
- ⚠️ Transferring from reserve may breach the emergency-fund target, and this
  page will not say so (§4.5). Mitigated by the `/plan` link; Open Item 8.2.

**Rejected alternatives**:

| Option | Why rejected |
|---|---|
| Include savings in the projected balance line | Destroys the feature. A household overspending by $500/month sees a flat line until the savings run out, and then a cliff with no warning. |
| A new advice rule (`shortfall_coverage`) instead of a page branch | The rule engine renders on `/plan`; the shortfall is stated on `/plan/cashflow`. A finding that appears two clicks from the number it is about is a finding nobody reads. Revisit if the sentence needs history gating or dismissal. |
| Suppress the alert entirely when covered | A monthly raid on the emergency fund is exactly the pattern worth surfacing. `info` states it without interrupting. |
| Show a "Transfer $3,030.33" button | Money movement. Out of scope, permanently. |
| Auto-size the suggested transfer to restore the cash floor too | Two numbers where one is needed, and it hides which part is the shortfall. The floor is already displayed beside the figure. |

---

## 5. Batches and tasks

### CF-00 — the gate

| # | Task | Deps |
|---|---|---|
| CF-00 | Append **ADR-047** and **ADR-048** to [IDEAS.md](IDEAS.md) §11 — **verify the max ADR number immediately before appending** (042 today; PLAN18 may land 043–046 first) and `awk -F'\|'` the new rows for stray pipes. Record the P17-style scope note in [FEATURE.md](FEATURE.md). **No code before this lands.** | — |

### CF-A — the stated schedule (ADR-047)

| # | Task | Deps |
|---|---|---|
| CF-A1 | Migration: `OBLIGATION_SOURCES += 'liability'` (CHECK), `liability_id uuid NULL` FK → `liabilities.id` `ON DELETE SET NULL` (explicit short name, ≤63 chars — the P14-03 lesson), partial UNIQUE `(liability_id) WHERE liability_id IS NOT NULL`. `drizzle-kit generate` + review the SQL by hand. **No column dropped.** | CF-00 |
| CF-A2 | `src/lib/cashflow/liability-obligations.ts` — **pure**. `liabilityCandidates({ liabilities, operatingAccounts, observedPayments, today })` → `LiabilityCandidate[]`. Implements ADR-047 §6 (observed median vs. computed P&I), §7 (cadence/anchor), §8 (account inference, or `accountId: null` when ambiguous). Calls the shipped `monthlyPayment()`. No I/O, no clock. | CF-00 |
| CF-A3 | `liability-obligations.test.ts` — the always-test surface. Escrowed payment ≥15% above P&I picks `trailing_median`; zero observed payments picks `fixed` and flags the escrow caveat; zero and several operating accounts both yield `accountId: null`; a paid-off / closed loan proposes nothing; anchor comes from the observed day-of-month; **the confirmed candidate's occurrence matches the real transaction** (the ADR-047 §4 double-count guard, asserted end-to-end through `matchOccurrences`). | CF-A2 |
| CF-A4 | `candidate-loader.ts` — load liabilities + operating accounts + trailing servicer outflows, call CF-A2, apply the existing `filterCandidates` suppression (confirmed via `liability_id`, dismissed via subject key `"liability <id>"`). Detection is unchanged and still computed on read. | CF-A2, CF-A1 |
| CF-A5 | Review page + confirm action: the "From your loan terms" section above detected candidates; both amounts in the evidence panel; account selector when `accountId` is null; **collision warning** when a detected candidate on the same account overlaps the proposed amount (ADR-047 consequence 4); confirm writes `source='liability'`, `detection_key=NULL`, `confidence=NULL`, `liability_id=<id>`. | CF-A4 |
| CF-A6 | `queries.ts` / `schemas/cashflow.ts`: carry `liabilityId` and the widened `source` through `ObligationRow`, `ObligationPatch` and the Zod boundary. Confirm the manual-entry path still rejects `liability_id` from user input — provenance is never form data (the P16-24 `confidence` lesson). | CF-A1 |
| CF-A7 | `/plan/cashflow` schedule list: a "from your loan terms" affordance on liability-sourced rows, so the household can see why a bill it never confirmed by hand is on the line. | CF-A5 |

### CF-B — closing the shortfall (ADR-048)

| # | Task | Deps |
|---|---|---|
| CF-B1 | `src/lib/cashflow/shortfall-close.ts` — **pure**. `classifyShortfall({ shortfall, reserveTotal, reserveAccountCount, unclassifiedCount })` → the four-member union + `remainingAfterTransfer`. All arithmetic through `Money`. | CF-00 |
| CF-B2 | `shortfall-close.test.ts` — reserve exactly equal to the shortfall is `covered` (boundary, mirroring safe-to-spend's "landing on the floor is not a shortfall"); reserve zero with classified accounts is `uncovered`, not `reserve_unknown`; unclassified-only cash is `reserve_unknown`; `partly_covered` clamps `remainingAfterTransfer` at zero; no `Number()` anywhere in the module (assert by source scan, as the privacy tests do). | CF-B1 |
| CF-B3 | `queries.ts`: `listReserveBalances()` — sibling of `listOperatingBalances`, routed through the same `tierForSubtype`, plus the unclassified count. `loader.ts` calls CF-B1 and carries the result on `CashFlowSnapshot`. One extra query, no snapshot re-read. | CF-B1 |
| CF-B4 | `alerts.ts`: `ShortfallInput` gains the classification; `covered` grades `info`, everything else keeps today's `critical`/`warning`. Dedup hash untouched. Extend `alerts.test.ts`. | CF-B3 |
| CF-B5 | `page.tsx` `Headline` — replace the static line at :218 with the four branches. Copy per ADR-048 §5: reserve total, transfer amount, date, what remains; `/accounts` link on `reserve_unknown`; `/plan` link for whether the reserve is still adequate. Figure-free `aria` labelling consistent with the existing headline. | CF-B3 |
| CF-B6 | `components/dashboard/cashflow-card.tsx` — a covered shortfall must not read as a crisis on the landing page either. Same union, shorter sentence. | CF-B3 |

### CF-C — proof

| # | Task | Deps |
|---|---|---|
| CF-C1 | Privacy pass: extend [cashflow/privacy-egress.test.ts](../../src/lib/cashflow/privacy-egress.test.ts) over both new modules — no outbound import, transitively; no servicer name, label, or figure in any log line. | CF-A2, CF-B1 |
| CF-C2 | Residual invariant: extend [residual.invariant.test.ts](../../src/lib/cashflow/residual.invariant.test.ts) with a liability-sourced obligation — confirming it must **re-date** spend, never increase total projected outflow over the horizon. This is §1's claim, asserted. | CF-A5 |
| CF-C3 | `pnpm check` + full suite + a `docs/` pass for anything describing the calendar's two doors or the shortfall copy. **Do not add a fourth Playwright flow** (CLAUDE.md caps it at three); extend the existing cash-flow assertions instead. | all |

---

## 6. Acceptance criteria

| # | Criterion |
|---|---|
| 1 | A household with a `loan` account and a `liabilities` row sees a pre-filled, correctly-amounted candidate on `/plan/cashflow/review` **before importing a single mortgage transaction**, and confirms it in one click. |
| 2 | After confirming, the projection line shows a **cliff on the payment day** and the stated coverage rises. |
| 3 | Total projected outflow over the horizon is **unchanged to the cent** by that confirmation (CF-C2) — the payment moved, it did not appear. |
| 4 | The confirmed occurrence **matches the real transaction** through the shipped matcher, so no `obligation_missed` alert fires on a mortgage that was paid (CF-A3). |
| 5 | Nothing is written to `scheduled_obligations` without a user click, on install or on upgrade. |
| 6 | A shortfall smaller than reserve cash renders as a timing statement with the transfer amount, the date, and the remainder — and its alert is `info`. |
| 7 | A shortfall with no classified reserve renders `reserve_unknown` and links to `/accounts`; unclassified cash is never counted as reserve. |
| 8 | The projected balance line, the low-water mark and safe-to-spend are **byte-identical** before and after CF-B (it changes description only). |
| 9 | `pnpm check` clean; suite green; no new dependency; no dropped column. |

---

## 7. Standing constraints, restated because this plan touches the money path

- **Money** (CLAUDE.md §Money — CRITICAL): every value a `numeric` string
  through [`Money`](../../src/lib/money/money.ts)/decimal.js. `Number()` appears
  nowhere in either new module — only at the display edge inside a client
  island. CF-A2 multiplies an amortization factor; that goes through
  `monthlyPayment()`, which already does it correctly.
- **Privacy**: zero egress. No servicer directory, no biller lookup, no rate
  feed. `monthlyPayment()` is arithmetic over stored terms. Nothing new is
  logged; the servicer descriptor is as sensitive as any other payee.
- **Dates**: UTC-midnight inclusive `YYYY-MM-DD`, expansion through the one
  `occurrenceDatesBetween` (ADR-036 §5). **This plan adds no date helper.**
- **Database**: nullable column, named FK under 63 chars, partial index,
  text+CHECK over `pgEnum`, no column dropped, `drizzle-kit generate` + hand
  review.
- **Scope**: no ledger, no envelopes, no money movement, no goals, no AI. CF-B
  is one sentence about a number the page already prints.

---

## 8. Open items (record, don't build)

1. **Interest/principal split on the calendar.** `balanceAtMonth()` could label
   each occurrence with its split. Deferred: the calendar answers *"what leaves
   and when"*, and a split invites a per-payment amortization view that belongs
   with the payoff simulator, not here.
2. **Emergency-fund adequacy after the suggested transfer** (ADR-048 §5). Needs
   `reserveMonthsFor()`, which needs a full `AdviceInput`. Revisit if
   `loadFinancialSnapshot` becomes cheap enough for a page render, or move the
   sentence to `/plan` where the input already exists.
3. **Escrow as a first-class concept.** Today it is absorbed by
   `trailing_median`. A real escrow model (tax + insurance components, annual
   re-analysis) is a phase, not a task, and the amount-drift alert already
   reports the yearly step.
4. **Other stated schedules the calendar still cannot see** — a `credit_lines`
   minimum payment, a CD maturity. Same shape as ADR-047; deliberately not
   generalized until a second real case exists.
5. **Suggesting which bill to move.** Round 12's neighbour. The page says
   *"moving a bill"* and still cannot say which; picking one needs a notion of
   which bills are movable, which nothing models.
