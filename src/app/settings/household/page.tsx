import { requireUser } from "@/lib/auth/require-user.ts";
import { loadHousehold } from "@/lib/household/queries.ts";
import Link from "next/link";
import { HouseholdManager, type MemberView, type ProfileView } from "./household-manager.tsx";

/**
 * `/settings/household` — the small amount of personal context household money
 * benchmarks need (Phase 15, P15-32, ADR-033 §4).
 *
 * A server component: it reads, converts `numeric` strings to their shortest
 * exact form for the form fields, and hands plain strings to the client island.
 *
 * ── The privacy note on this page is required, not decorative ──────────────
 * This is the only screen in the app that asks about PEOPLE rather than money —
 * names, birth years, whether someone depends on this income. That is the most
 * personal thing the app has ever asked for, and a user is entitled to know why
 * it is being asked and where it goes before they type it. Saying so plainly, on
 * the page, at the moment of asking, is the whole point (CLAUDE.md §Privacy).
 *
 * The claims it makes are enforced elsewhere, not merely asserted here: the
 * guidance engine makes zero outbound HTTP on any code path, `label` is
 * deliberately excluded from the ⌘K search index (ADR-033 §7), these rows ride
 * the same `age`-encrypted nightly dump as everything else (ADR-014), and the
 * notification email carries no figures at all (ADR-015). A Batch-7 regression
 * test holds the search exclusion in place.
 */
export default async function HouseholdSettingsPage(): Promise<React.JSX.Element> {
  await requireUser();
  const { profile, members } = await loadHousehold();

  const profileView: ProfileView | null = profile
    ? {
        reserveMonthsOverride: profile.reserveMonthsOverride?.toString() ?? "",
        retirementTargetAge: profile.retirementTargetAge?.toString() ?? "",
        benchmarkSavingsApy: trimScale(profile.benchmarkSavingsApy),
        needsPct: trimScale(profile.needsPct),
        wantsPct: trimScale(profile.wantsPct),
        savingsPct: trimScale(profile.savingsPct),
        highInterestThresholdApr: trimScale(profile.highInterestThresholdApr),
      }
    : null;

  const memberViews: MemberView[] = members.map((member) => ({
    id: member.id,
    label: member.label,
    birthYear: member.birthYear?.toString() ?? "",
    isDependent: member.isDependent,
  }));

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div>
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          ← Dashboard
        </Link>
        <h1 className="mt-2 font-semibold text-2xl tracking-tight">Household</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          A few facts that make the guidance fit your situation instead of an average one — how many
          months of expenses you want in reserve, whether anyone depends on this income, and where
          you draw the line on expensive debt. Everything here is optional; without it the app uses
          conventional defaults and says so.
        </p>
      </div>

      <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <h2 className="font-medium">Where this goes</h2>
        <p className="mt-1 max-w-3xl text-zinc-600 dark:text-zinc-400">
          Nowhere. This is the most personal information the app asks for, so plainly: it is stored
          in your own database on this machine, it is never sent anywhere, and no part of the
          guidance that reads it makes a network request of any kind. Names are not searchable and
          never appear in notification emails. It is included in your encrypted nightly backup along
          with everything else.
        </p>
      </div>

      <HouseholdManager profile={profileView} members={memberViews} />
    </main>
  );
}

/**
 * Trim a `numeric` value to its shortest exact form for a form field.
 *
 * Postgres returns `benchmark_savings_apy` as `"4.5000"`; round-tripping that
 * through the form would show the user noise. Purely a string operation — no
 * value is parsed to a number and no precision is lost, because trailing
 * fractional zeros are all that is ever removed.
 *
 * @param value - A `numeric` string such as `"4.5000"`, or null.
 * @returns `"4.5"`; `""` when the column is null.
 */
function trimScale(value: string | null): string {
  if (value === null) return "";
  if (!value.includes(".")) return value;
  return value.replace(/\.?0+$/, "");
}
