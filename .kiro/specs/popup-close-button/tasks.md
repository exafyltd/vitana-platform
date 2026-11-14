# Tasks — popup-close-button

<!-- lane: close-button -->

- [ ] 1. Add the un-hide override to `EditShortVideoModal`'s `DialogContent` className
  (`[&>button]:not-sr-only [&>button]:absolute [&>button]:end-4 [&>button]:top-4`).
- [ ] 2. Confirm with the class merge that `[&>button]:sr-only` is removed and `[&>button]:not-sr-only` is kept.
- [ ] 3. Add the read-only staging spec `tests/e2e/staging/popup-close-button.staging.spec.ts` (390×844 and 1440×900).
- [ ] 4. Run ESLint on the changed file and confirm no new errors.

**Acceptance**
- Change types: UI
- The Edit Video Details dialog shows an X in its upper-right corner at 390×844 and 1440×900.
- The X closes the dialog, and Cancel still works.
- Save behaviour, the title and tag fields, and thumbnail capture are unchanged.
- No file outside `paths` changes; `dialog.tsx` is not touched.
- The staging spec never sends a non-GET request and never clicks Save.
- ESLint is clean on the changed file.
