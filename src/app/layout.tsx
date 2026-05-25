import type { Metadata } from "next";
import "./globals.css";
import { AppNav } from "@/components/app-nav.tsx";
import { db } from "@/db/client.ts";
import { users } from "@/db/schema/index.ts";

export const metadata: Metadata = {
  title: "my-money",
  description: "Self-hosted, single-user personal finance tracker.",
};

interface RootLayoutProps {
  readonly children: React.ReactNode;
}

export default async function RootLayout({
  children,
}: RootLayoutProps): Promise<React.JSX.Element> {
  // Lightweight gate: if there are no users yet (first-run), or no session, the
  // nav stays hidden. Pages handle their own auth redirects; this just decides
  // whether to render chrome.
  const userCount = await db.select({ id: users.id }).from(users);
  const showNav = userCount.length > 0;

  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-50">
        {showNav && <AppNav />}
        <div className={showNav ? "pt-2" : ""}>{children}</div>
      </body>
    </html>
  );
}
