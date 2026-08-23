# PLAN — Navigation redesign: grouped top bar + section strip + manifest

**Type**: chrome / information-architecture rewrite (not a phase).
**Blast radius**: `src/components/app-nav.tsx`, `src/components/nav-menu.tsx`,
`src/components/command-palette.tsx`, `src/lib/search/global.ts`, one new
`src/lib/nav/` module, seven new section `layout.tsx` files. **No page bodies, no
schema, no jobs, no new dependency.**

**Status**: ✅ **Implemented 2026-08-23** on `feat/nav-redesign`. ADR-035 is
locked in [IDEAS.md](IDEAS.md) §11; NAV-01…NAV-13 in §7 are all done. Three
deviations from this document, recorded in §11.

**Skills consulted** (per [SKILLS.md](SKILLS.md)):
`architecture-decision-records` (Tier 2 — "whenever a new significant decision
arises"), `nextjs-app-router-patterns` (Tier 1 — server/client split, section
layouts), `tailwind-patterns` (Tier 2 — responsive chrome), `typescript-pro`
(Tier 2 — the manifest is an `as const` structure feeding four consumers),
`e2e-testing-patterns` (Tier 1 — the nav touches the three critical Playwright
flows), `react-state-management` (Tier 3 — consulted and *declined*: one
`useState` per island, no Zustand, per CLAUDE.md §Zustand).

---

## 1. The problem, counted

[`nav-menu.tsx`](../../src/components/nav-menu.tsx#L21-L34) renders a flat
`LINKS` array of **12 destinations**, plus a Search trigger and a Sign-out form,
inside a `max-w-5xl` row. At the default 16 px base that is ~1,010 px of content
in a 1,024 px container *before* the brand mark — it wraps or clips on any
laptop, and each phase has been appending to the array:

| Group today | Destinations |
|---|---|
| — | Dashboard, Accounts, Transactions, Investments, Watchlist, Analysis, Plan, Categories, Income, Household, Connections, Alerts |

Three structural faults, not just an overflow:

1. **No hierarchy.** `Categories`, `Income`, `Household`, `Connections` are all
   `/settings/*` but read as peers of `Dashboard`. Four of the twelve slots are
   spent on configuration the user visits twice a year.
2. **Second-level pages are invisible.** `/analysis/budgets`, `/analysis/review`,
   `/investments/performance`, `/investments/forecast` exist and are reachable
   only from ad-hoc inline links inside page bodies
   ([analysis/page.tsx:162-165](../../src/app/analysis/page.tsx#L162-L165),
   [investments/security/\[id\]/page.tsx:118](../../src/app/investments/security/[id]/page.tsx#L118)).
   The real destination count is **19**, not 12.
3. **Adding a feature edits the chrome.** Every phase has touched `LINKS`. There
   is no single place that answers "what can this app show me?" — the palette
   ([command-palette.tsx](../../src/components/command-palette.tsx)) knows about
   *records* (accounts, categories, securities, watchlist, transactions) but
   **not about pages**, so a destination that falls off the bar becomes
   unreachable by keyboard too.

---

## 2. Scope

### In scope

- A **nav manifest** — one typed module that is the single source of truth for
  every destination, its group, and its match prefixes.
- **Grouped top bar**: 5 group triggers with disclosure dropdowns + 3 utility
  controls (search, alerts, account).
- **Section strip**: a second-level tab row rendered by a per-section
  `layout.tsx`, showing the current group's siblings.
- **Mobile accordion**: the existing hamburger panel, grouped, current group
  auto-expanded.
- **Palette pages**: a `page` result kind so every manifest destination is
  ⌘K-reachable regardless of nesting depth.
- **Vitest** on the pure resolver functions, including a coverage guard that
  fails when a `page.tsx` exists with no manifest entry.

### Explicitly NOT in scope

- **A left sidebar.** Rejected in ADR-035 — see §6.1.
- **Any change to a page body.** All 29 pages keep their own `max-w-*`
  container; the chrome stays a horizontal band above them.
- **Breadcrumbs.** The manifest makes them a ~20-line follow-up, but two levels
  of nav plus a breadcrumb is redundant at this depth. Recorded in §10.
- **Icons in the nav.** Text labels only; the app has no icon set and adding one
  is a separate decision.
- **Nav customization / reordering / pinning.** Single user, curated IA — same
  posture as ADR-029's "no dashboard customization".
- **Renaming any route.** The IA regroups labels; every `href` stays exactly
  where it is, so no redirects and no broken bookmarks.

---

## 3. Target information architecture

Five groups, capped. Each group's first item is its landing page.

| Group | Items (in order) | Routes |
|---|---|---|
| **Dashboard** | *(single, no dropdown)* | `/` |
| **Accounts** | All accounts · Transactions | `/accounts`, `/transactions` |
| **Investing** | Portfolio · Performance · Forecast · Watchlist | `/investments`, `/investments/performance`, `/investments/forecast`, `/watchlist` |
| **Planning** | Overview · Budgets · Review queue · Guidance | `/analysis`, `/analysis/budgets`, `/analysis/review`, `/plan` |
| **Settings** | Categories · Income · Household · Connections | `/settings/categories`, `/settings/income`, `/settings/household`, `/settings/connections` |

Utilities, right-aligned, always visible:

| Control | Behaviour |
|---|---|
| **Search** | Existing ⌘K trigger; dispatches `OPEN_COMMAND_PALETTE_EVENT`, unchanged |
| **Alerts** | Bell + red count badge → `/alerts`. A notification, not a section — it stays a permanent affordance rather than hiding inside a group |
| **Account** (⋯) | Sign out today; the landing spot for future appearance / backup-status / about entries |

Detail and flow routes are **not** top-level entries. They attach to their parent
via `match` prefixes so the parent stays lit while you are inside them:

| Route | Attaches to | Mechanism |
|---|---|---|
| `/accounts/new`, `/accounts/[id]`, `/accounts/[id]/import/**` | All accounts | `href` prefix |
| `/investments/security/[id]` | Portfolio | `match: ['/investments/security']` |
| `/analysis/category/[id]` | Overview | `href` prefix (longest-match keeps `/analysis/budgets` distinct) |
| `/watchlist/new`, `/watchlist/[id]`, `/watchlist/[id]/edit` | Watchlist | `href` prefix |
| `/settings/connections/[id]/map`, `/…/progress` | Connections | `href` prefix |

### Bar budget

```text
┌────────────────────────────────────────────────────────────────────┐
│ my-money   Dashboard  Accounts▾  Investing▾  Planning▾  Settings▾   │
│                                            [Search ⌘K]  🔔 3   ⋯   │
└────────────────────────────────────────────────────────────────────┘
```

Five triggers ≈ 380 px of text at `text-sm`, versus ~1,010 px today. The bar
holds a **sixth** group before it is under pressure again — and ADR-035's
scaling rule 2 says a seventh group means the taxonomy is wrong, not that the
bar needs another slot.

---

## 4. Target design

### 4.1 The manifest — `src/lib/nav/manifest.ts`

Pure data plus pure functions. **No React import, no `next/navigation` import**,
so it is equally importable from a client island, a server component, and the
`GET /api/search` route handler.

```ts
import type { Route } from 'next';

/** A dynamic count rendered beside a label; resolved at render, never stored here. */
export type BadgeSlot = 'alerts';

export interface NavItem {
  /** Typed route literal — satisfies Next typed-routes with no cast. */
  readonly href: Route;
  readonly label: string;
  /** One-line subtitle shown in the dropdown and in ⌘K page results. */
  readonly description: string;
  /** Extra path prefixes that light this item (detail/flow routes). */
  readonly match?: readonly string[];
  /** Exact-match only. `'/'` is the sole user. */
  readonly exact?: boolean;
  readonly badge?: BadgeSlot;
}

export type NavGroupId =
  | 'dashboard' | 'accounts' | 'investing' | 'planning' | 'settings';

export interface NavGroup {
  readonly id: NavGroupId;
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [ /* §3 table */ ] as const;

/** Right-aligned utilities. A separate array — they are not a group. */
export const NAV_UTILITIES: readonly NavItem[] = [
  {
    href: '/alerts',
    label: 'Alerts',
    description: 'Open anomalies and price triggers',
    badge: 'alerts',
  },
] as const;
```

### 4.2 The resolvers — `src/lib/nav/resolve.ts`

Four pure functions, no I/O, no React. These are what get unit-tested.

```ts
export interface NavMatch { readonly group: NavGroup; readonly item: NavItem }

/**
 * Longest-prefix match across every item's href and match[] entries.
 * `exact` items match only on strict equality — otherwise `'/'` would win
 * every path. Returns null for routes outside the manifest (`/login`).
 */
export function resolveActive(pathname: string): NavMatch | null;

/** The current group's items, or [] when the group has ≤1 item. */
export function sectionItemsFor(pathname: string): readonly NavItem[];

/** True when this item should render as aria-current="page". */
export function isCurrent(item: NavItem, pathname: string): boolean;

/** Every destination, flattened, for the ⌘K page group. */
export function allDestinations(): readonly (NavItem & { groupLabel: string })[];
```

**Longest-prefix, not first-match**, is the whole trick.
`/investments/performance` matches both `/investments` and
`/investments/performance`; the longer wins. `/analysis/category/abc` matches
`/analysis` only, because it does not start with `/analysis/budgets`. This is
why the resolver needs a test and the components do not.

### 4.3 Component tree and the server/client line

Per `nextjs-app-router-patterns` — server by default, islands only where state
lives.

```text
src/app/layout.tsx                    server
└── AppNav                            server  ← reads openAlertCount()
    ├── brand <Link>                  server
    ├── NavBar             'use client'  ← ONLY state: which group is open
    │   ├── NavGroupMenu   (disclosure button + <ul> of <Link>)
    │   ├── SearchTrigger  (dispatches the existing event)
    │   ├── AlertsBell     (badge count passed down as a prop)
    │   └── AccountMenu    (disclosure; Sign-out form)
    └── CommandPalette     'use client'  ← unchanged mount point

src/app/investments/layout.tsx         server  ← new
└── SectionNav groupId="investing"   'use client'  ← usePathname() only
```

- `AppNav` **stays a server component** and keeps its
  [`openAlertCount()`](../../src/lib/alerts/queries.ts) read. Badge counts are
  passed as `badges: Partial<Record<BadgeSlot, number>>` — the manifest never
  performs I/O, so a future `badge: 'review'` slot is one loader line, not a
  refactor.
- `NavBar` holds exactly one piece of state: `openGroup: NavGroupId | null`.
  `useState`, not Zustand — CLAUDE.md §Zustand says server components come first
  and Zustand is for state shared across *unrelated* client components.
- `SectionNav` is a thin client component because active state needs
  `usePathname()`. Mounting it from a **section `layout.tsx`** (not from each
  page) means it persists across navigation *within* the section instead of
  remounting — the App Router idiom, and it keeps page bodies untouched.

### 4.4 Accessibility — disclosure, not `menubar`

**Use the ARIA APG *Disclosure Navigation Menu* pattern, not `role="menubar"`.**
`menubar`/`menuitem` semantics contract for application menus and oblige roving
`tabindex`, typeahead, and arrow-key wraparound; these are navigation *links*,
and screen-reader users expect a list of links. Getting this wrong is the single
most common defect in a grouped nav.

| Requirement | Implementation |
|---|---|
| Trigger | `<button aria-expanded={open} aria-controls={panelId}>` — no `aria-haspopup="menu"` |
| Panel | `<ul>` of `<Link>`, hidden via conditional render |
| Open | Click / Enter / Space. Hover-intent **may** open at `sm:`+ but click must always work |
| Close | `Esc` (focus returns to the trigger), click outside, `Tab` past the last link, route change |
| Exclusivity | One group open at a time — the single `openGroup` state enforces it |
| Current page | `aria-current="page"` on the active link; the active group's trigger gets a persistent underline |
| Section strip | `<nav aria-label="Investing sections">` — a distinct landmark name per group |
| Alerts badge | The count sits inside the link text with an `<span className="sr-only">` suffix: `"3 open alerts"`. A bare red circle is not a label |
| Reduced motion | No dropdown animation, or `motion-reduce:transition-none` |

### 4.5 Mobile

The existing `sm:hidden` hamburger panel keeps its structure and gains grouping:
group labels become collapsible headers, and the group containing the current
route is **expanded on open**. The section strip is `hidden sm:flex` — on mobile
its items are already in the accordion, so rendering both is duplication.

### 4.6 The palette becomes the escape hatch

Add `'page'` to `SearchResultKind` in
[`src/lib/search/global.ts`](../../src/lib/search/global.ts) and prepend a
**Pages** group ahead of Accounts. Page matching is a local, synchronous
substring/prefix filter over `allDestinations()` — **no database query, no
`pg_trgm`** — so it costs nothing and returns instantly, before the debounced
record search resolves.

This is what makes the design scale honestly: a destination that is three clicks
deep in a dropdown is still **one keystroke away**. ADR-035's scaling rule 4
makes manifest membership mandatory precisely so this stays true.

---

## 5. What changes, file by file

| File | Change |
|---|---|
| `src/lib/nav/manifest.ts` | **new** — groups, items, utilities |
| `src/lib/nav/resolve.ts` | **new** — the four pure resolvers |
| `src/lib/nav/resolve.test.ts` | **new** — longest-prefix, exact `/`, coverage guard |
| `src/components/app-nav.tsx` | badge map instead of a bare `alertCount` |
| `src/components/nav-menu.tsx` | **rewritten** as `NavBar` — reads the manifest, `openGroup` state, disclosure panels, grouped mobile accordion |
| `src/components/nav-group-menu.tsx` | **new** — one reusable disclosure (used by groups *and* the ⋯ account menu) |
| `src/components/section-nav.tsx` | **new** — `usePathname()` + `sectionItemsFor()` |
| `src/app/{accounts,transactions,investments,watchlist,analysis,plan,settings}/layout.tsx` | **new**, ~8 lines each — render `<SectionNav>` |
| `src/lib/search/global.ts` | `'page'` added to `SearchResultKind`; pages prepended |
| `src/components/command-palette.tsx` | `GROUP_LABELS` / `GROUP_ORDER` gain `page` |
| `src/app/analysis/page.tsx`, `src/app/investments/page.tsx`, `src/app/accounts/page.tsx` | **delete** the ad-hoc inline cross-links now covered by the section strip |

Deliberately **not** touched: every page body's container, any route path, any
schema, any job.

---

## 6. Alternatives rejected

### 6.1 Left sidebar

The best answer for a large IA, and the wrong answer *here*. Every one of the 29
pages centers itself with its own `max-w-*` (19 × `max-w-3xl`, 12 × `max-w-5xl`,
plus `2xl`/`4xl`/`xl` one-offs). A sidebar means rewriting the container on all
of them plus `src/app/layout.tsx`, to display the same 19 destinations the
grouped bar displays for free. Revisit **only** when the taxonomy genuinely
needs a seventh group — ADR-035 records this as the designated upgrade path so
the decision is not re-litigated from scratch.

### 6.2 Flat bar + a "More" overflow menu

The cheapest fix and a trap: `More` acquires no meaning, so every future feature
lands in it and the discoverability problem returns worse than before — a
12-item unlabelled dropdown instead of a 12-item bar.

### 6.3 Mega-menu panel

A full-width panel with columns and descriptions. Over-built for 19
destinations; the payoff starts at roughly triple that.

### 6.4 `role="menubar"` semantics

See §4.4. Costs roving tabindex + typeahead + arrow wraparound to make links
announce as application menu items, which is worse for screen readers.

### 6.5 Palette-only navigation

Delete the bar, keep ⌘K. Undiscoverable for an app used weekly rather than
hourly, and unusable on mobile where there is no keyboard shortcut.

### 6.6 Headless UI / Radix Navigation Menu

The obvious dropdown dependencies. Rejected: the disclosure behaviour in §4.4 is
~40 lines, and this project's posture (ADR-006, ADR-009, ADR-013 — all "zero new
dependency") makes a UI-chrome dependency a poor trade for a self-hosted app
whose supply chain the user personally carries.

---

## 7. Task breakdown

| ID | Task | Depends on |
|---|---|---|
| NAV-01 | `manifest.ts` — groups, items, utilities, `Route`-typed hrefs | — |
| NAV-02 | `resolve.ts` — `resolveActive`, `sectionItemsFor`, `isCurrent`, `allDestinations` | NAV-01 |
| NAV-03 | `resolve.test.ts` — longest-prefix cases, exact `/`, `/login` → `null`, every `match` prefix | NAV-02 |
| NAV-04 | Coverage-guard test: glob `src/app/**/page.tsx`, map each to a route, assert `resolveActive` ≠ `null` (allow-list `/login`) | NAV-02 |
| NAV-05 | `nav-group-menu.tsx` — the reusable disclosure, §4.4 keyboard contract | — |
| NAV-06 | Rewrite `nav-menu.tsx` → `NavBar`: desktop groups + utilities | NAV-01, NAV-05 |
| NAV-07 | Grouped mobile accordion, current group auto-expanded | NAV-06 |
| NAV-08 | `app-nav.tsx` — pass a `badges` map instead of `alertCount` | NAV-06 |
| NAV-09 | `section-nav.tsx` + the seven section `layout.tsx` files | NAV-02 |
| NAV-10 | Delete the ad-hoc inline cross-links the strip now covers | NAV-09 |
| NAV-11 | Palette `page` kind: `global.ts`, `GROUP_LABELS`, `GROUP_ORDER` | NAV-01 |
| NAV-12 | Extend the existing Phase 1 Playwright flow with a grouped-nav assertion (**do not add a fourth critical flow** — CLAUDE.md caps it at three) | NAV-06, NAV-09 |
| NAV-13 | `pnpm check` + full suite; update any doc under [docs/](../../docs/) that names the old bar | all |

All thirteen are complete. `tsc --noEmit` and `biome check` are clean (one
pre-existing `useSortedClasses` warning in `account-admin.tsx`, untouched here);
`vitest run` is 1,375 passing across 123 files, including the 32 resolver +
coverage-guard cases and 8 page-matcher cases this change added.

---

## 8. Acceptance criteria

| # | Criterion |
|---|---|
| 1 | The bar renders ≤6 group triggers + 3 utilities and does not wrap at 1,024 px |
| 2 | Every route under `src/app` except `/login` resolves to exactly one group (NAV-04 proves it) |
| 3 | Every destination is reachable in ⌘K by typing part of its label |
| 4 | `Esc` closes an open group and returns focus to its trigger; `Tab` past the last link closes it |
| 5 | The active group trigger and the active link both show state; the link carries `aria-current="page"` |
| 6 | Deep routes (`/accounts/[id]/import/[batchId]/preview`, `/investments/security/[id]`) light their parent group |
| 7 | Zero page bodies modified apart from NAV-10's link deletions |
| 8 | Zero new npm dependencies |
| 9 | Adding a hypothetical destination requires editing **only** `manifest.ts` |

---

## 9. Risks

| Risk | Catch |
|---|---|
| A future page ships with no manifest entry and silently vanishes from nav *and* palette | NAV-04's coverage guard fails CI |
| `usePathname()` in `SectionNav` re-renders the strip on every navigation | It is ~30 lines of links with no data fetch; mounting from `layout.tsx` keeps it out of the page's own render path |
| Longest-prefix resolution mis-fires on a future route like `/analysis/budgets-archive` | NAV-03 includes a sibling-prefix case; `match[]` is the documented override |
| The 5-group taxonomy ages badly | ADR-035 caps groups at 6 and names the sidebar as the designated upgrade — a re-grouping decision, not an append |
| Dropdowns break the three Playwright flows if they select nav links by text | NAV-12 updates them in the same change |

---

## 10. Deferred follow-ups (record, don't build)

- **Breadcrumbs** — `breadcrumbFor(pathname)` is ~20 lines on top of the
  manifest. Wait until a third nesting level actually exists.
- **Icons** in group triggers and the mobile accordion — needs an icon-set
  decision first.
- **Palette commands** ("Add account", "Import statement") as a second,
  non-navigational kind. ADR-027 locked the palette as **read-only, never
  mutating**, so actions would reopen it and need their own ADR.
- **A `review` badge slot** on Planning → Review queue, showing the
  uncategorized count. The `badges` map in §4.3 already accommodates it.

---

## 11. Deviations from this design, as built

Three, all small, all deliberate:

1. **`nav-menu.tsx` became `nav-bar.tsx`.** §5 said "rewritten as `NavBar`" while
   keeping the path. Every other component in `src/components/` is named for its
   export (`app-nav.tsx` → `AppNav`, `section-nav.tsx` → `SectionNav`), so the
   file was renamed to match rather than leaving `nav-menu.tsx` exporting
   `NavBar`.

2. **`searchPages()` lives in a new `src/lib/search/pages.ts`, not in
   `global.ts`.** §4.6 put the `page` kind in `global.ts` — which it is, as a
   union member — but `global.ts` imports `server-only`, and §4.6 also requires
   page matching to be **synchronous and local to the client island**. The two
   cannot both hold in one module, so the pure matcher is its own file and
   `global.ts` gained only the type. `command-palette.tsx` imports the matcher
   directly; the `SearchResult` type import stays type-only and is erased.

3. **`SectionNav` panel links carry `aria-describedby`, not an inline
   description.** Putting `item.description` inside the `<a>` made the link's
   *accessible name* "Watchlist Symbols you track and their price targets", which
   is both wrong for screen readers and unmatchable by an exact-name Playwright
   locator. The description is now `aria-hidden` inside the link and referenced
   by `aria-describedby`, so the name is the label and the blurb is announced as
   a description. Same pixels, correct semantics.

### Test-suite repairs made along the way

The E2E suite had three **pre-existing** failures unrelated to this change,
which had to be fixed to verify NAV-07 and NAV-12:

- `auth.spec.ts`, `phase1.spec.ts`, `phase6-mobile.spec.ts` asserted a "Net
  worth" heading immediately after bootstrap. Since P13-16 an account-less
  install renders `FirstRunDashboard` ("Welcome") instead. Assertions updated;
  `phase1` now asserts the net-worth hero at step 5, where it actually exists.
- `phase10-assets.spec.ts` had two latent strict-mode violations
  (`getByText(/uploaded/i)` also matching the "Uploaded" column header;
  `locator("table")` matching two tables on the account detail page). Both were
  previously masked because the spec failed at the nav step first.

Separately, running the **whole** E2E suite in one process exhausted Postgres
connections (`sorry, too many clients already`) partway through — the Next dev
server accumulated one pool per compiled route entry. This reproduced
identically on `master` and was not caused by this change; it is fixed on its
own branch (`fix/db-pool-per-module-leak`) by parking the pool on `globalThis`.
With that fix the full suite runs in one pass and peaks at 10 connections.

---

*End of PLAN_NAV.md*
