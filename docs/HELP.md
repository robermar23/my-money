# In-app help

Every signed-in page has help: press **`?`**, click the **?** beside Search, or
pick "Help: *this page*" in ⌘K. This document is for whoever writes or changes
that help. The full authoring guide (adding a page, adding a tour and its
anchors) lands with Phase 20's last batch (PLAN20 P20-33); the copy rules below
apply now.

Help is typed data, not Markdown: one module per nav group under
[src/lib/help/content/](../src/lib/help/content/), and the shared definitions in
[src/lib/help/glossary.ts](../src/lib/help/glossary.ts).

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
| The type checker | An entry naming a glossary term that does not exist, or a related link to a route that does not exist |

## `<Term>`: a definition on the page itself

[term.tsx](../src/components/help/term.tsx) wraps a label in a dotted
underline that opens its glossary definition. It opens on click, tap, Enter or
Space and closes on `Esc` or a click outside; it does not open on hover. Use it
sparingly, only where the word itself is the confusion. Today it is on four
labels: the two return tiles on Performance, *Safe to spend* on Cash flow, and
*Required today* on Sinking funds.

## Tours

A page's tour is the `tour` field of its help entry. Each step names a
`data-tour` anchor, which must be listed in `TOUR_ANCHORS`
([types.ts](../src/lib/help/types.ts)) and written once, as a literal, on the
element it highlights:

```tsx
<section data-tour="cashflow-chart">…</section>
```

A step whose anchor is not on the page (an empty list, a section hidden at
phone width) is skipped. A tour with fewer than two steps left is not offered.
Tours start only from a click: "Take the tour" in the panel, or the "New here?"
chip shown once per device. Bump the tour's `version` to offer it again after
the page changes. The full authoring guide lands with PLAN20 P20-33.
