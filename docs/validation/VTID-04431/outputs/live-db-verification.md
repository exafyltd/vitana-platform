# Live DB verification (read-only, 2026-09-23)

| check | result |
|---|---|
| anon can execute `support_resolution_search` | false |
| authenticated can execute | false |
| service_role can execute | true |
| `memory_items` rows with category `support_ticket` | 0 |
| resolved / user_confirmed tickets | 5 resolved, 0 with `resolution_md` |
