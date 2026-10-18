import localFont from "next/font/local";

/*
 * The app's two typefaces, self-hosted from the Fontsource npm packages.
 *
 * `next/font/local` rather than `next/font/google`: the Google loader downloads
 * the files during `next build`, which would make every Docker build reach out
 * to Google and fail offline. These files ship in node_modules, so neither the
 * build nor the browser contacts anyone (CLAUDE.md §Privacy). next/font still
 * preloads them and sizes a metric-matched fallback, so text does not jump
 * when the real face arrives.
 *
 * Latin only: it covers English and Western European payee names; anything
 * outside it falls back to the system face. Both are variable fonts with an
 * optical-size axis, so one file serves every weight and size.
 */

/** Inter: the interface face, and every figure (see `--font-mono` in globals.css). */
export const inter = localFont({
  src: "../../node_modules/@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-inter",
});

/** Source Serif 4: page and section headings only. */
export const sourceSerif = localFont({
  src: "../../node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-normal.woff2",
  weight: "200 900",
  display: "swap",
  variable: "--font-source-serif",
  adjustFontFallback: "Times New Roman",
});
