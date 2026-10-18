# Third-party licenses

my-money is licensed **AGPL-3.0-or-later** ([LICENSE](../LICENSE), ADR-050). This
page records the one-time check that nothing it depends on conflicts with that
license or carries an obligation we are not meeting. It was **run, not
assumed**, so a future audit knows when it last happened and what it found.

## How it was run

```sh
pnpm licenses list --json          # every installed package (dev + prod)
pnpm licenses list --prod --json   # what the runtime image needs
```

- **Date:** 2026-10-10 (PLAN19 P19-02), pnpm 11.3.0, on the tree at Phase 19 Batch 1.
- **Host:** Windows x64. Platform-specific prebuilds (the `*-win32-x64*` packages
  below) are replaced by their `linux-x64` / `linux-arm64` siblings in the Docker
  image. Those siblings carry the same license as the package they belong to.

## Result

**Nothing to do.** No dependency is incompatible with AGPL-3.0-or-later, and
this repository needs no top-level `NOTICE` file. Each package ships its own
license text (and, for `playwright`, `playwright-core` and `@playwright/test`,
its Apache-2.0 `NOTICE`) inside `node_modules`, and the Docker image's runtime
stage copies `node_modules` whole, so those files travel with the packages.

| License | All packages | Runtime (`--prod`) |
| --- | ---: | ---: |
| MIT | 225 | 107 |
| ISC | 26 | 13 |
| Apache-2.0 | 14 | 9 |
| BSD-3-Clause | 8 | 3 |
| BlueOak-1.0.0 | 8 | — |
| BSD-2-Clause | 2 | — |
| MIT OR Apache-2.0 | 2 | — |
| MIT-0 | 2 | 1 |
| MPL-2.0 | 2 | — |
| Apache-2.0 AND LGPL-3.0-or-later | 1 | 1 |
| CC-BY-4.0 | 1 | 1 |
| Unlicense | 1 | 1 |
| 0BSD | 1 | 1 |
| MIT AND ISC | 1 | 1 |
| OFL-1.1 | 2 | 2 |
| **Total** | **296** | **140** |

## Named explicitly: copyleft and attribution-requiring dependencies

Any dependency that is not plain permissive is listed here by name, even when
the answer is "fine", so that nobody has to re-derive it.

- **`@img/sharp-*` (Apache-2.0 AND LGPL-3.0-or-later).** sharp is Next.js's
  optional image optimizer, and its prebuilt binaries bundle **libvips**, which
  is LGPL-3.0-or-later. **Weak copyleft.** It is used unmodified as a dynamically
  loaded library, and its license text ships inside the package. LGPL-3.0 is
  compatible with AGPL-3.0, so nothing further is required.
- **`lightningcss` (MPL-2.0), dev only.** Tailwind v4's CSS compiler.
  **File-level weak copyleft.** It runs at build time and we do not modify its
  files, so no obligation reaches this repository. MPL-2.0 is compatible with
  the GPL family.
- **`caniuse-lite` (CC-BY-4.0).** Browser-support data used by the build
  toolchain and Next.js. **Attribution-requiring.** The attribution travels
  with the package's own license file.
- **`@fontsource-variable/inter`, `@fontsource-variable/source-serif-4` (OFL-1.1).**
  The interface and heading typefaces, added 2026-10-18. **Font license.** The
  font files are bundled into the app and served to the browser, which the SIL
  Open Font License allows for software that is not sold as the font itself.
  The license text ships inside each package. OFL-1.1 places no obligation on
  the AGPL code that uses the fonts.
- **`postgres` (Unlicense).** The Postgres driver. **Public domain.** Listed
  only because it is unusual, not because it carries any obligation.
- **BlueOak-1.0.0 (`chownr`, `jackspeak`, `minimatch`, `minipass`,
  `package-json-from-dist`, `path-scurry`, `tar`, `yallist`), dev only.**
  A permissive model license, comparable to MIT.

**No GPL-only, AGPL, SSPL, BUSL, Commons Clause or "non-commercial" dependency**
exists in either set.

## Re-running it

Re-run the two commands above when you add a dependency whose license you have
not seen before, and update this page if the result changes. A change to the
counts alone needs no edit; a **new license name** does.
