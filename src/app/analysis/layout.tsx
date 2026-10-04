import { SectionNav } from "@/components/section-nav.tsx";

/**
 * Section layout for `/analysis` (NAV-09).
 *
 * Exists solely to mount the {@link SectionNav} strip for the **Planning**
 * group. Mounting from the layout rather than each page keeps the strip alive
 * across in-section navigation and leaves every page body — and its own
 * `max-w-*` container — untouched (ADR-035 rule 7).
 */
export default function AnalysisLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <SectionNav groupId="analysis" />
      {children}
    </>
  );
}
