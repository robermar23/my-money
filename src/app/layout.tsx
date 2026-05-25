import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "my-money",
  description: "Self-hosted, single-user personal finance tracker.",
};

interface RootLayoutProps {
  readonly children: React.ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps): React.JSX.Element {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-50">
        {children}
      </body>
    </html>
  );
}
