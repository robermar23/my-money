import { SectionNav } from "@/components/section-nav.tsx";

/**
 * Section layout for `/settings` (NAV-09).
 *
 * Exists solely to mount the {@link SectionNav} strip for the **Settings**
 * group. Mounting from the layout rather than each page keeps the strip alive
 * across in-section navigation and leaves every page body — and its own
 * `max-w-*` container — untouched (ADR-035 rule 7).
 */
export default function SettingsLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <SectionNav groupId="settings" />
      {children}
    </>
  );
}
