# Responses to sparring round 1

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "transitionChain tracks parked_from through the chain: it starts at the base front matter's parked_from, an edge X → parked sets it to X, and the next parked → Y edge is checked with {state:'parked', parked_from}. A head in state parked must carry the tracked parked_from. Plan §3.1 'Every edge is legal' updated.", "deferred_to": ""},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "The citation was wrong: web-steering.md:56-57 puts merge: in the in-review → verified entry and :59-60 writes Merge `<sha>` in verified → done. verified → done now needs a merge sha in either form (case-insensitive) in its own entry or in the in-review → verified entry of the same window, so both existing conventions pass. Plan §2.4 and §3.1 updated.", "deferred_to": ""},
  {"finding_id": "R1-F3", "disposition": "accepted", "rationale": "Added to §3.5: valid executing → parked → executing → in-review; invalid executing → parked → in-review; invalid head parked whose parked_from differs from the tracked value.", "deferred_to": ""}
]
```
