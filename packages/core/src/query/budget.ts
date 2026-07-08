/**
 * Token budgets are a first-class parameter of every query (principle #3).
 * The estimator is deliberately model-agnostic — chars/4 with a 15% safety
 * margin — because chasing per-model tokenizers would make responses
 * non-deterministic across consumers. The BudgetWriter guarantees BY
 * CONSTRUCTION that rendered output never exceeds its budget: it refuses
 * lines that don't fit, and list truncation always reserves room for an
 * explicit drill-down hint before committing an item.
 */

export const MIN_BUDGET = 200;
export const MAX_BUDGET = 20_000;
export const DEFAULT_BUDGET = 2_000;

const CHARS_PER_TOKEN = 4;
const SAFETY_MARGIN = 1.15;

export function clampBudget(requested: number | undefined): number {
  if (requested === undefined || Number.isNaN(requested)) return DEFAULT_BUDGET;
  return Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, Math.floor(requested)));
}

export function estimateTokens(text: string): number {
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY_MARGIN);
}

/** Largest character count whose estimate still fits inside the budget. */
export function maxCharsFor(budgetTokens: number): number {
  return Math.floor((budgetTokens * CHARS_PER_TOKEN) / SAFETY_MARGIN);
}

/** A sensible bigger budget to suggest in drill-down hints. */
export function suggestBudget(current: number): number {
  return Math.min(MAX_BUDGET, Math.ceil((current * 2) / 1000) * 1000);
}

export class BudgetWriter {
  readonly budget: number;
  private readonly maxChars: number;
  private chars = 0;
  private lines: string[] = [];
  private droppedContent = false;

  constructor(budgetTokens: number) {
    this.budget = clampBudget(budgetTokens);
    this.maxChars = maxCharsFor(this.budget);
  }

  /** True if some line or list item had to be dropped to stay in budget. */
  get truncated(): boolean {
    return this.droppedContent;
  }

  private costOf(text: string): number {
    return text.length + (this.lines.length > 0 ? 1 : 0); // +1 for the joining "\n"
  }

  private fits(text: string): boolean {
    return this.chars + this.costOf(text) <= this.maxChars;
  }

  /** Append the line if it fits; otherwise drop it and report false. */
  line(text: string): boolean {
    if (!this.fits(text)) {
      this.droppedContent = true;
      return false;
    }
    this.lines.push(text);
    this.chars += this.costOf(text);
    return true;
  }

  blank(): boolean {
    // Never let a separator be the reason real content gets dropped later:
    // a blank line is cosmetic, so it only goes in with room to spare.
    return this.fits("") ? this.line("") : false;
  }

  /**
   * Append items in order until the budget runs out. Before committing an
   * item, room is reserved for the hint that would be emitted if the NEXT
   * item didn't fit — so a truncated list can always say "+N more → ...".
   * Returns how many items were written.
   */
  list(items: string[], makeHint: (omitted: number) => string): number {
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as string;
      const isLast = i === items.length - 1;
      if (isLast) {
        if (this.line(item)) return items.length;
        this.line(makeHint(1));
        return i;
      }
      const hintAfterThis = makeHint(items.length - i - 1);
      const roomForBoth =
        this.chars + this.costOf(item) + hintAfterThis.length + 1 <= this.maxChars;
      if (!roomForBoth) {
        this.droppedContent = true;
        this.line(makeHint(items.length - i));
        return i;
      }
      this.line(item);
    }
    return items.length;
  }

  toString(): string {
    return this.lines.join("\n");
  }
}
