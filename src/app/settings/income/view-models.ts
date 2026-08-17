/**
 * The shapes the server page hands the client components (P14-14).
 *
 * Deliberately plain data with no Drizzle or `Money` types: these cross the
 * server/client boundary, so everything is a string or a boolean. Money arrives
 * PRE-FORMATTED (`grossDisplay`, `totalEmployeeDisplay`, …) because formatting
 * is a `Money.format()` call and money math belongs on the server — the browser
 * never does arithmetic on a dollar figure (CLAUDE.md §Money).
 *
 * Raw `numeric` strings still travel for the *editable* fields, because a form
 * has to round-trip the stored value unchanged.
 */

/** An investment account a contribution rule may fund. */
export interface AccountView {
  readonly id: string;
  readonly name: string;
  readonly institution: string;
}

/** A position inside one of those accounts. */
export interface HoldingView {
  readonly id: string;
  readonly accountId: string;
  readonly symbol: string;
  /** Already carries Plaid-synced lots — see the double-count warning (P14-12). */
  readonly hasPlaidLots: boolean;
}

/** The 401k rule attached to a source, plus what the job has done with it. */
export interface RuleView {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly holdingId: string;
  readonly holdingSymbol: string | null;
  readonly employeeBasis: string;
  readonly employeeValue: string;
  readonly pretax: boolean;
  readonly matchBasis: string;
  readonly matchValue: string;
  readonly matchCapPercent: string;
  readonly active: boolean;
  readonly materializedCount: number;
  readonly lastPayDate: string | null;
  readonly totalEmployeeDisplay: string;
  readonly totalEmployerDisplay: string;
  /** True when the targeted holding also has Plaid lots (double-count risk). */
  readonly doubleCountRisk: boolean;
}

/** A paycheck the user has defined. */
export interface SourceView {
  readonly id: string;
  readonly name: string;
  readonly cadence: string;
  readonly grossPerPeriod: string;
  readonly grossDisplay: string;
  readonly currency: string;
  readonly anchorDate: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly notes: string;
  readonly active: boolean;
  /**
   * `end_date` is set and already in the past — this paycheck is finished, so
   * the nightly job will never materialize another contribution for it.
   *
   * Computed on the SERVER rather than from `new Date()` in the client island:
   * the two clocks can straddle midnight, and a "today" that differs between the
   * server render and hydration is a React text mismatch.
   */
  readonly ended: boolean;
  readonly startsInFuture: boolean;
  readonly rule: RuleView | null;
}
