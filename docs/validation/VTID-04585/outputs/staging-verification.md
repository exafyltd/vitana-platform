# VTID-04585 — staging verification (build b6bd5c2)

Staging served `b6bd5c2` on 8/8 build-info samples. I ran four authenticated
`de` Nova sessions with the test account and asked "Wem folge ich eigentlich
in der Community? Nenn mir bitte die Namen." (Polly PCM).

| Trial | Tool called | Reply |
|---|---|---|
| 1 | list_followers | "Du folgst derzeit Mariia Maksina in der Community. …" |
| 2 | — | greeting blocked by Nova's content filter (see VTID-04589) |
| 3 | list_followers | "Du folgst derzeit Mariia Maksina in der Community. …" |
| 4 | get_recommendations, list_followers | "Du folgst derzeit einer Person in der Community: Mariia Maksina. …" |

All three trials that reached the question answered correctly, with no
contradicting "no followers" line. Before this fix, on build 8fa030b: trial 1
said "Du hast derzeit noch keine Follower"; trial 2 named Mariia and then
contradicted itself.

The model still picks `list_followers` for this question. The fix is that this
result now also names who the user follows, so the wrong pick answers
correctly.
