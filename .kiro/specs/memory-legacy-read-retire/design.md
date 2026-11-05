# Design — memory-legacy-read-retire
See plan.md. `readMemoryContext` keeps the no-identity guard, then returns the recall result or the not-ok shape the
forced-recall branch returns today. The legacy six-query block, `forcePath`, the shadow call, the five legacy repository
fetchers and `recall-shadow.ts` are deleted. Deploy-workflow flag pins are left as they are (protected gate file).
