# VTID-04124 — measured outputs

All queries read-only against the live Supabase project. No writes beyond the
`vtid_ledger` row for this VTID itself (CLAUDE.md §4.1).

## 1. `code='nova_validation'` bundles two unrelated failures (14 days)

| day | content_filter | idle_timeout_55s | other |
|---|---:|---:|---:|
| 2026-09-20 (partial) | 3 | 4 | 1 |
| 2026-09-19 | 15 | 3 | 2 |
| 2026-09-18 | 5 | 2 | 4 |
| 2026-09-17 | 2 | 10 | 0 |
| 2026-09-16 | 0 | 7 | 3 |
| 2026-09-15 | 5 | 20 | 13 |
| 2026-09-14 | 1 | 9 | 5 |
| 2026-09-13 | 2 | 11 | 1 |

The idle-timeout variant dominates most days and its share moves independently,
so any rate computed over `code='nova_validation'` is a moving blend.

## 2. Real content-filter rate, by origin (14 days)

| origin | logged in | sessions | blocked | rate |
|---|---|---:|---:|---:|
| `https://vitanaland.com` | yes | 307 | 31 | **10.1%** |
| `https://preview-aws.vitanaland.com` | yes | 330 | 1 | 0.3% |
| `https://preview-aws.vitanaland.com` | no | 17 | 0 | 0.0% |

## 3. Per-user concentration (30 days, production, ≥3 sessions)

| user | lang | sessions | blocked | rate |
|---|---|---:|---:|---:|
| `0adc6ff6` | de | 43 | 15 | 34.9% |
| `67c971fc` | de | 38 | 6 | 15.8% |
| `c7d3260d` | en | 27 | 2 | 7.4% |
| `1f2e76f2` | de | 33 | **0** | 0.0% |
| `a27552a3` | en / de | 35 | **0** | 0.0% |
| `f5bb44a2` | de | 15 | **0** | 0.0% |
| `c31cd211` | de | 15 | **0** | 0.0% |
| *(6 more users, 3–10 sessions each)* | | | **0** | 0.0% |

23 of 31 blocks come from two accounts; ten other accounts have none.

## 4. Rate by rung (30 days, production, authenticated)

| rung / band | sessions | blocked | rate |
|---|---:|---:|---:|
| `legacy_default` 550–700 chars | 14 | 11 | **78.6%** |
| `legacy_default` other lengths | 21 | **0** | **0.0%** |
| `override_v2` | 7 | 3 | 42.9% |
| `conv_resume` | 12 | 3 | 25.0% |
| `newday_overview` | 137 | 13 | 9.5% |

### `legacy_default` by length band — all blocks in one band

| prompt_len ≤ | sessions | blocked |
|---:|---:|---:|
| 100 (anonymous intro) | 16 | 0 |
| 400 | 3 | 0 |
| 500 | 2 | 0 |
| **700 (short-gap)** | **14** | **11** |

## 5. Within-user, heaviest-hit account (`0adc6ff6`)

| rung | blocked | not blocked | avg prompt_len (blocked) |
|---|---:|---:|---:|
| `legacy_default` (no wake_opener) | 7 | 4 | 664 |
| `newday_overview` | 3 | 16 | 14,983 |
| `override_v2` | 3 | 1 | 1,300 |
| `conv_resume` | 3 | 4 | n/a |

Same account, same memory: the ~660-char rung blocks, the ~20,000-char rung
mostly passes.

## 6. Reverse-causality split (the 14 short-gap sessions)

| preceded by a content-filter block on the same user within 30 min | sessions | blocked | rate |
|---|---:|---:|---:|
| yes | 7 | 7 | 100% |
| no | 7 | 4 | 57.1% |

## 7. Branch-length attribution

`node` reproduction of each legacy branch's composed length confirms the
observed 659 / 675 / 678 values land in the `recent` / `reconnect` band
(598–663 with representative screen titles), and rules the apology branch out
(147–203):

```
reconnect  len 598–658
recent     len 603–663   exact match: 659 (timeAgo="1 hour ago", screen="Meine Gesundheit")
same_day   len 557–617
apology    len 147–203
```
