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
