import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppNav } from "@/components/app-nav.tsx";
import { getSession } from "@/lib/auth/session.ts";
import { readTheme } from "@/lib/theme/server.ts";
import { inter, sourceSerif } from "./fonts.ts";

export const metadata: Metadata = {
  title: "my-money",
  description: "Self-hosted, single-user personal finance tracker.",
};

// P6-17: opt into proper mobile scaling so the app renders at device width
// instead of a zoomed-out desktop viewport on phones.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
  // A picked theme goes on <html> server-side so the first paint is already right.
  const theme = await readTheme();

  return (
    <html
      lang="en"
      className={`${inter.variable} ${sourceSerif.variable}`}
      data-theme={theme === "system" ? undefined : theme}
    >
      <body className="min-h-screen bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-50">
        {showNav && <AppNav />}
        <div className={showNav ? "pt-2" : ""}>{children}</div>
      </body>
    </html>
  );
}
