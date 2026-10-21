/**
 * VTID-03259 (Fix-3) — brain-opener region sentinels.
 *
 * vitana-brain's PROACTIVE INITIATIVE OFFER (V2) block is a single string that
 * contains NESTED `=== … ===` subsections (STEP 1 — YOUR VERY FIRST UTTERANCE,
 * ON NO, ON HARDER REFUSAL). The heading-based stripBrainOpenerSections() regex
 * stops at the first nested `===`, so STEP 1 — a competing "speak this verbatim
 * first utterance" directive — used to SURVIVE the strip and fight the
 * wake-brief / journey-guide override for control of turn 1. That was the
 * single-opener "mixing".
 *
 * Wrapping the whole V2 block in these opaque sentinels lets the stripper
 * remove the entire region as one unit, regardless of how many `===`
 * subsections it contains. Shared here so producer (vitana-brain) and consumer
 * (live-system-instruction) agree on the exact markers without a circular
 * import.
 */
export const BRAIN_OPENER_V2_START = '<<BRAIN_OPENER_V2_START>>';
export const BRAIN_OPENER_V2_END = '<<BRAIN_OPENER_V2_END>>';
