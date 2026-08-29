import Decimal from "decimal.js";

// Configure decimal.js once: 28-digit precision is overkill for personal finance,
// but it's the cheap insurance against accumulated rounding when summing thousands
// of transactions over years. ROUND_HALF_EVEN is banker's rounding (the GAAP default).
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

/**
 * ISO 4217 currency code. Kept as a branded string so a literal "USD" can be
 * passed where a `Currency` is expected without ceremony, but a free-text string
 * cannot. Validation happens at construction time.
 */
export type Currency = string & { readonly __brand: "Currency" };

/** Coerce an unvalidated string into a Currency, throwing if it's not a plausible code. */
export function toCurrency(code: string): Currency {
  if (!code || code.trim().length === 0) {
    throw new Error("Currency code is required");
  }
  return code.trim().toUpperCase() as Currency;
}

/**
 * Money — exact decimal arithmetic + a currency tag.
 *
 * Per CLAUDE.md §Money & Numeric Precision: NEVER do `a + b` on raw money
 * numbers — always go through this class. The class is immutable; every
 * operation returns a new Money instance.
 *
 * The underlying Decimal is kept private; callers interact via `toString()`,
 * `format()`, or by passing other Money values into arithmetic methods.
 */
export class Money {
  private readonly amount: Decimal;
  public readonly currency: Currency;

  private constructor(amount: Decimal, currency: Currency) {
    this.amount = amount;
    this.currency = currency;
  }

  /** Parse a string amount into Money. Throws on invalid input. */
  static fromString(amount: string, currency: string): Money {
    if (amount === undefined || amount === null || amount === "") {
      throw new Error("Money amount is required");
    }
    let decimal: Decimal;
    try {
      decimal = new Decimal(amount);
    } catch {
      throw new Error(`Invalid money amount: ${amount}`);
    }
    return new Money(decimal, toCurrency(currency));
  }

  /** Construct a Money of zero for the given currency. */
  static zero(currency: string): Money {
    return new Money(new Decimal(0), toCurrency(currency));
  }

  /**
   * Sum a list of Money values. All values must share the given currency.
   * An empty list returns Money.zero(currency).
   */
  static sum(values: readonly Money[], currency: string): Money {
    const target = toCurrency(currency);
    let total = new Decimal(0);
    for (const v of values) {
      if (v.currency !== target) {
        throw new Error(`Cannot sum: expected currency ${target}, got ${v.currency}`);
      }
      total = total.plus(v.amount);
    }
    return new Money(total, target);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  sub(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  /** Multiply by a unitless scalar (a count, a percentage, an FX factor). */
  mul(scalar: string | number): Money {
    return new Money(this.amount.times(new Decimal(scalar)), this.currency);
  }

  /** Divide by a unitless scalar, rounded to 2 decimal places (cents). */
  div(scalar: string | number): Money {
    const result = this.amount.dividedBy(new Decimal(scalar)).toDecimalPlaces(2);
    return new Money(result, this.currency);
  }

  /**
   * Divide by a unitless scalar, truncated toward zero at cents.
   *
   * The companion to {@link div}, and the difference matters exactly once: when
   * the quotient is a RATE that will later be multiplied back by the same
   * divisor. `div` rounds half-even, so $1,200 over 31 days becomes $38.71 and
   * 31 days of it is $1,200.01 — a cent the household never spent. Multiplied
   * across a year-long projection that error only ever accumulates in the
   * direction that overstates outflow, which understates safe-to-spend, which
   * is the direction ADR-038 §2 calls the dangerous one.
   *
   * Use `div` to SPLIT a known total (a bill three ways, a median of two
   * values), where half-even is the fair rounding. Use `divFloor` for a rate.
   *
   * Truncation rather than floor-toward-minus-infinity, so the magnitude only
   * ever shrinks whichever side of zero the value sits on.
   *
   * @param scalar - The unitless divisor.
   * @returns A new Money whose magnitude is never larger than the exact quotient.
   */
  divFloor(scalar: string | number): Money {
    const result = this.amount
      .dividedBy(new Decimal(scalar))
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);
    return new Money(result, this.currency);
  }

  negate(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  equals(other: Money): boolean {
    if (this.currency !== other.currency) return false;
    return this.amount.equals(other.amount);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  /**
   * Order two amounts of the same currency.
   *
   * The comparison callers need in order to SORT money — computing a median,
   * finding a low-water mark — without the two things that quietly break it:
   * `Number(a) - Number(b)`, which reintroduces the float this class exists to
   * avoid, and `a.sub(b).isNegative()`, which is correct but leaves every call
   * site reimplementing a comparator.
   *
   * @param other - The value to compare against. Must share this currency.
   * @returns -1 when this is smaller, 0 when equal, 1 when larger — the
   *   `Array.prototype.sort` comparator contract.
   * @throws If the currencies differ. Ordering across currencies is meaningless
   *   without an FX rate and a date, so it is refused rather than guessed.
   */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.amount.comparedTo(other.amount) as -1 | 0 | 1;
  }

  /**
   * Magnitude, discarding the sign.
   *
   * Used where a value is a size rather than a movement — an obligation's
   * expected amount, a dispersion measure. Sign conventions differ between
   * `transactions.amount` and display, so the conversion is explicit here
   * rather than assumed at each call site.
   *
   * @returns A Money of the same currency with a non-negative amount.
   */
  abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  isNegative(): boolean {
    return this.amount.isNegative();
  }

  /**
   * Canonical money string with 2 decimal places ("1234.56", "100.00", "0.30").
   *
   * Always returns cents-precision regardless of how the value was constructed.
   * This matches the shape of Postgres `NUMERIC(18,2)` storage. Never use for
   * arithmetic — use Money methods.
   */
  toString(): string {
    return this.amount.toFixed(2);
  }

  /**
   * Format for human display using `Intl.NumberFormat`. Locale defaults to en-US.
   *
   * IMPORTANT: this is the only acceptable place to bridge from Decimal to
   * `number`. The conversion is lossy in principle but the display itself
   * already collapses to ~2 decimal places, so any precision loss here is below
   * the user-visible threshold.
   */
  format(locale = "en-US"): string {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: this.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(this.amount.toNumber());
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} vs ${other.currency}. Convert through fx_rates first.`,
      );
    }
  }
}
