Per connected member (high case):

| Tier / item | Rows per connected member | Bytes/row incl. indexes | Retention |
|---|---|---|---|
| 5-minute series | 1,000/day → 31,000 steady | 200 | 30 days (daily partitions dropped) |
| Hourly series | 100/day → 36,500/year | 200 | lifetime |
| Daily series | 50/day → 18,250/year | 200 | lifetime |
| Records | 20/day → 7,300/year | 400 | lifetime |
| Upserts incl. hourly/daily recomputes (≈ 24 syncs/day) | ≈ 1,600/day | — | — |
| Backfill at connect (31 d 5-minute, 60 d hourly, 90 d daily + records) | ≈ 43,000 rows, ≈ 3.4 MB JSON, ≈ 0.4 MB gzip, 9 store calls (≤ 5,000 items) / 43 wire batches (≤ 1,000 records) | — | — |
| S3 raw batches | ≈ 12 KB gzip/day + backfill | — | 30 days (lifecycle) |

Scenarios at 40% connected:

| Scenario | Members → connected | 5-minute tier (steady) | Lifetime tiers growth | Year-one total | Upserts/day (avg; peak ×10) | Backfill wave | S3 (30 d) |
|---|---|---|---|---|---|---|---|
| S (today) | 450 → 180 | 1.1 GB | 2.5 GB/yr | ≈ 3.6 GB | 288,000 (3/s; 33/s) | 7.74 M rows (13/s over 7 days) | ≈ 0.1 GB, ≈ 131,220 objects |
| M | 10,000 → 4,000 | 25 GB | 55 GB/yr | ≈ 80 GB | 6.40 M (74/s; 741/s) | 172 M rows (284/s over 7 days) | ≈ 3.1 GB, ≈ 2.92 M objects |
| L | 100,000 → 40,000 | 248 GB | 555 GB/yr | ≈ 803 GB | 64.0 M (741/s; 7,407/s) | 1.7 B rows (2,844/s over 7 days) | ≈ 31 GB, ≈ 29.2 M objects |

Re-evaluation triggers (alarmed by A2, Change 11):

- 5-minute tier > 150 GB
- health upserts > 1,000/s sustained for 1 h
- health tables > 40% of cluster write I/O for a week
- > 15,000 connected members

Model scenarios crossing a trigger (peak upserts treated as sustained): S: none; M: none; L: tier_5m_gb, peak_upserts_per_sec, connected_members.
