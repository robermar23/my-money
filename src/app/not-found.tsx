import Link from "next/link";

export const metadata = { title: "Not found — my-money" };

/**
 * The 404 page, for unknown URLs and for any `notFound()` call (an account or
 * security id that no longer exists).
 *
 * Returns:
 *   The not-found panel.
 */
export default function NotFound(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="font-semibold text-2xl tracking-tight">Nothing here</h1>
      <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
        This page does not exist, or the account or record it pointed to has been removed.
      </p>
      <p className="mt-6 text-sm">
        <Link href="/" className="underline underline-offset-2">
          Go to the dashboard
        </Link>{" "}
        or press <kbd className="font-code">Ctrl-K</kbd> to search.
      </p>
    </main>
  );
}
