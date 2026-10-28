# Responses to sparring round 1
```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified with git ls-tree on origin/main 28aaab2331: of the seven, only native-wave2-home-feed-news, desktop-spotlight-finish and sparring-floor-retry have a spec folder on main; native-wave2-events-calendar, -sharing-business, -profile-settings and i18n-propagate-stale-write exist only on their open plan( PR heads (#4271, #4349, #4278, #4157). The R4 problem statement now says 'listed by no programme' and names which are on main and which only on PR heads. Item 5 now requires the builder to take every slug from a tree (main, or the open PR head via git ls-tree -d) and record its source in commands.log. Item 6's test additionally asserts each added slug matches /^[a-z0-9][a-z0-9-]*$/ and is listed exactly once across all programmes.",
    "deferred_to": null
  }
]
```
