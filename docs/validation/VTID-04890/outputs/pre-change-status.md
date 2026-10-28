# Pre-change get_onboarding_status for the typeless draft (2026-10-05, via Claude on staging)

- business_type: not set
- ready_to_submit: false
- missing_to_submit: []
- steps: []
- next_step: null

Cause: `loadChecklist` returns `checklist: null` when `partner_type` is not a valid type
(`routes/partner-onboarding.ts:119`); `shapeStatus` fell back to empty values.
