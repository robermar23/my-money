import { GLOSSARY, type GlossaryTermId } from "@/lib/help/glossary.ts";
import { TermDisclosure } from "./term-disclosure.tsx";

/**
 * A jargon word on a page that opens its glossary definition (PLAN20 P20-12).
 *
 * Server-safe: it looks the definition up here and hands the client
 * disclosure only that one term's strings, so a page using `<Term>` never
 * ships the whole glossary to the browser.
 *
 * **Use it sparingly**, on the few headline labels where the word itself is
 * the confusion (time-weighted versus money-weighted return, safe to spend,
 * required today). It is not for every number on every page.
 *
 * @param id - The glossary key; a key the glossary lacks does not compile.
 * @param align - `end` for a right-aligned label, so the definition stays on screen.
 * @param children - The word as the page prints it.
 */
export function Term({
  id,
  align = "start",
  children,
}: {
  readonly id: GlossaryTermId;
  readonly align?: "start" | "end";
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const entry = GLOSSARY[id];
  return (
    <TermDisclosure term={entry.term} means={entry.means} tellsYou={entry.tellsYou} align={align}>
      {children}
    </TermDisclosure>
  );
}
