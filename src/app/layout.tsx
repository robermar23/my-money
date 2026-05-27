import type { Metadata } from "next";
import "./globals.css";
import { AppNav } from "@/components/app-nav.tsx";
import { getSession } from "@/lib/auth/session.ts";

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
  // Render the nav only when the request carries a valid session cookie.
  // Anonymous visits to /login don't get the nav (it would just bounce them
  // right back to /login anyway).
  const session = await getSession();
  const showNav = Boolean(session.userId);

  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-50">
        {showNav && <AppNav />}
        <div className={showNav ? "pt-2" : ""}>{children}</div>
      </body>
    </html>
  );
}
