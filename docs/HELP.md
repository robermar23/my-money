# In-app help

Every signed-in page has help: press **`?`**, click the **?** beside Search, or
pick "Help: *this page*" in ⌘K. This document is for whoever writes or changes
that help: how to add it for a new page, the rules its words follow, how to add
a tour, and what the tests check.

Help is typed data, not Markdown: one module per nav group under
[src/lib/help/content/](../src/lib/help/content/), and the shared definitions in
[src/lib/help/glossary.ts](../src/lib/help/glossary.ts). It is bundled with the
app, so it works offline and never reads your data (see
[What help never does](#what-help-never-does)).

## Adding help for a new page

A new page needs a help entry, and the tests say so: `coverage.test.ts` fails
until it has one.

1. **List the route** in [routes.ts](../src/lib/help/routes.ts), in its nav
   group's array, written the way the guard writes it: each dynamic segment
   becomes `<id>` (`/accounts/<id>/import`). `/login` is the only page without
   help, because it has no chrome to put a `?` in.
2. **Write the entry** in that group's module under
   [content/](../src/lib/help/content/): `route`, a `title` that matches the
   page's own heading, a one-sentence `summary` (the question the page
   answers), and `sections`. Use the usual headings: *How to read it*, *What
   you can do here*, *When it looks wrong*, or *How to fill it in* for a form.
   Body text is a list of blocks (`paragraph`, `steps`, `definition`,
   `callout`) whose strings are rendered as text, never as HTML.
3. **Name the words the page uses** in `terms`, from the
   [glossary](../src/lib/help/glossary.ts). A term the glossary lacks does not
   compile. Add a new glossary term only if the page prints those exact words.
4. **Add `relatedRoutes`** for the pages a reader is likely to want next. Each
   must be a nav destination, which supplies its label.
5. **Update the module's header comment** to name the files and docs the entry
   was written from (copy rule 7).
6. Run `pnpm test src/lib/help`. The copy guard counts the words and checks the
   rules below.

An entry with no `tour` is complete. Most pages do not need one.

## Copy rules (PLAN20 P20-11)

1. **Second person, plain words.** "You", not "the user". Say what the page is
   for, how to read it, what you can do there, and why it might look wrong. The
   entries use those as their headings: *How to read it*, *What you can do
   here*, *When it looks wrong*. A form page reads *How to fill it in*.
2. **Use the page's own words.** If the page says "cash cushion", the help says
   "cash cushion", even where the code says `cash_floor`. The glossary follows
   the UI, never the other way round, and a test enforces it.
3. **No figure the app computes, and no dollar amounts at all.** Help is static
   and never reads your data. A static example figure would read as one of
   yours.
4. **No tax advice** beyond what the guidance disclaimer already says.
5. **Stand on your own.** Never point the reader at a file in `docs/` or at a
   website. If the reader would need the doc, the entry is not finished.
6. **150–300 words a page.** A page that needs more is a page that needs
   fixing. Record it in the phase's Open Items rather than writing more.
7. **Source every claim** from the shipped page or its document, and say which
   in the module's header comment. Help that describes a page that has changed
   is worse than none.

## What the tests check

| Guard | What fails it |
|---|---|
| [coverage.test.ts](../src/lib/help/coverage.test.ts) | A page with no help entry, or two entries for one page |
| [copy.test.ts](../src/lib/help/copy.test.ts) | A placeholder entry; fewer than 150 or more than 300 words; a `docs/` path, `.md` file or URL; a dollar figure; a related link that is not a nav destination; a glossary term that no page prints; a glossary term no entry uses |
| [load.test.ts](../src/lib/help/load.test.ts) | An entry filed in the wrong group's module |
| [anchors.test.ts](../src/lib/help/anchors.test.ts) | A tour step whose `data-tour` anchor is in no page; a `data-tour` no tour uses, written twice, or computed (`data-tour={…}`); a tour with fewer than 3 or more than 6 steps; a step body over two sentences |
| [checklist.test.ts](../src/lib/help/checklist.test.ts) | A getting-started "Take the tour" link to a page that has no tour; a dollar figure in an item |
| [privacy-egress.test.ts](../src/lib/help/privacy-egress.test.ts) | Anything help runs importing `@/db`, a package beyond `react`, `react-dom`, `next/link` and `next/navigation`, or a network API; any HTML sink (`dangerouslySetInnerHTML`, `innerHTML`, `eval`); browser storage outside [local-store.ts](../src/lib/help/local-store.ts); a key outside `my-money:help:`; interpolation in the help copy |
| [e2e/phase20-help.spec.ts](../e2e/phase20-help.spec.ts) | `?`, "Take the tour", every dashboard tour step, and "not offered again" after a reload, in a real browser |
| The type checker | An entry naming a glossary term that does not exist, or a related link to a route that does not exist |

## `<Term>`: a definition on the page itself

[term.tsx](../src/components/help/term.tsx) wraps a label in a dotted
underline that opens its glossary definition. It opens on click, tap, Enter or
Space and closes on `Esc` or a click outside; it does not open on hover. Use it
sparingly, only where the word itself is the confusion. Today it is on four
labels: the two return tiles on Performance, *Safe to spend* on Cash flow, and
*Required today* on Sinking funds.

## Tours

A tour earns its place on a page that is dense, or whose main figure is easy to
misread. A form or a list does not need one. A page's tour is the `tour` field
of its help entry. To add one:

1. **Choose three to six things to point at**, in the order a reader's eye
   should go. Each step is a short title and a body of at most two sentences.
2. **Name an anchor for each** in `TOUR_ANCHORS`
   ([types.ts](../src/lib/help/types.ts)), prefixed with the tour's id
   (`cashflow-chart`). A step naming an anchor not in that list does not
   compile.
3. **Put the anchor on the page**, once, as a literal attribute on the element
   it highlights:

   ```tsx
   <section data-tour="cashflow-chart">…</section>
   ```

4. **Add the tour to the entry**: `{ id, version: 1, steps }`. The id is the
   page's short name and becomes part of the device's storage key.
5. **Walk it on demo data** (`make seed-demo`) at desktop and phone widths, in
   both themes, and run `pnpm test src/lib/help`.

A step whose anchor is not on the page (an empty list, a section hidden at
phone width) is skipped. A tour with fewer than two steps left is not offered.
Tours start only from a click: "Take the tour" in the panel, the "New here?"
chip shown once per device, or a link ending `#tour` (the first-visit chip
starts that page's tour on arrival and drops the fragment). **Bump the tour's
`version`** to offer it again on devices that have seen it, after the page
changes enough that the old tour would mislead.

The tour card is keyboard-first. It takes focus on each step and keeps `Tab`
inside itself. `Esc` ends the tour, and the arrow keys move between steps.
Under `prefers-reduced-motion` it does not animate its scrolling.

Choosing an anchor, as learned writing the first fourteen tours:

- **Attributes only.** Add `data-tour` to an element that already exists; never
  wrap something to make room for one.
- **One source location.** A component with several `return` branches cannot
  carry an anchor, because it would be written more than once. Anchor its
  parent in the page instead, as the dashboard does with its card grid.
- **Small beats whole.** Anchor a section's heading row rather than a long table
  or list. An anchor taller than most of the screen is scrolled to its top, and
  the card then has to sit over it.
- **Rows repeat; that is fine.** An anchor inside a mapped row is written once in
  source and appears on every row; the tour highlights the first.
- **Shared anchors.** One anchor can serve several tours: `inputs-used` sits on
  the "Based on" disclosure that Plan, Cash flow and Sinking funds all render.
- **Check it on demo data at both widths.** Some steps only exist for some data
  (a mortgage's terms, a connection needing a sign-in); make sure each variant
  still leaves at least two steps.

## The getting-started checklist

The dashboard shows five setup items: add an account, bring in transactions,
get the review queue under a fixed number, make a rule of your own, switch on
backups. The items live in [checklist.ts](../src/lib/help/checklist.ts).

- **Derived, never stored.** Each item ticks itself when the thing is done. The
  facts come from [checklist-facts.ts](../src/lib/dashboard/checklist-facts.ts):
  the accounts the dashboard already read, three reads that stop at a few rows,
  and the backup state the Instance page reads. A rule counts as "your own" when
  its pattern is not one of the default set.
- **Gone for good.** Dismissing it, or seeing it with everything done, stores
  `my-money:help:checklist` on that device, and it never comes back, even if an
  item later slips. On a brand-new install it sits under "Add your first
  account" and cannot be dismissed.
- **No settings.** The review-queue target is a constant, `REVIEW_QUEUE_TARGET`.
- An item links to the page where it is done, and to that page's tour when the
  page has one. Item copy follows the rules above.

## What help never does

- **It never reads your data.** Help is static text bundled with the app. No
  help module imports the database, and none makes a request: the panel loads
  its group's text as a script chunk from your own server. That is why help
  states no figure of yours. It has none to state.
- **It never writes HTML.** Every string is rendered as text, and emphasis is a
  typed `{ strong }` span, not markup.
- **It keeps one kind of state, on your device.** `localStorage` holds a mark
  per tour (`my-money:help:tour:<id>:v<version>`, set to `seen` or `dismissed`)
  and one for the checklist (`my-money:help:checklist`, set to `dismissed` or
  `done`). Nothing is stored on the server, so a second browser offers the tours
  again. Clearing site data resets them, and that is harmless.

`privacy-egress.test.ts` enforces all three.
