# Sparring round 2 — converged

Session: `efadbe18-afbe-452c-8138-e3a248f109e7` · plan hash `f19d1e9800078fcace02fd897e1135fe495c3040e43f23e32f0035471394324b`

## Summary

Round 2 review of the revised plan. All three R1 findings were accepted and properly addressed in the revised plan. I verified the key premises against the pinned commit and confirmed the plan's description of existing code is accurate for the files that exist at the pinned commit. The `heldPublic`/`flushPublic` bypass mechanism (R1-F1), the directive branching and new native backstop timers (R1-F2), and the timeout conflict check (R1-F3) are all well-specified in the revision. One new minor finding regarding a missing file reference in the plan's "Today" section.

## Findings

### R2-F1 [minor]

The plan's decision 3 says 'OverlayHost.tsx:10-21 is unchanged' and decision 4 says the utility-bar lane will register `vitana:open-life-compass` and `gift-voucher:open` listeners in OverlayHost. The file is at `apps/mobile/src/shell/OverlayHost.tsx` (not `src/shell/components/OverlayHost.tsx`). The plan references `OverlayHost.tsx:10-21` in item 3 of the Today section, but the actual lines are 12-21 for the component and 10 is the `useBusEvent` import. This is cosmetic but the plan should use the correct path (`src/shell/OverlayHost.tsx`) so the lane's `paths` list is accurate — the file is NOT under `src/shell/components/`.

- `exafyltd/vitana-v1:apps/mobile/src/shell/OverlayHost.tsx:1` — export function OverlayHost() {
    const { t } = useI18n();
    const [adminOpen, setAdminOpen] = useState(false);
    useBusEvent('adminInBrowser:open', () => setAdminOpen(true));
    return (
      <BottomSheet testID="admin-in-browser" open={adminOpen} onClose={() => setAdminOpen(false)} title={t('native.adminInBrowser.title')}>
        <Text muted>{t('native.adminInBrowser.body')}</Text>
      </BottomSheet>
    );
  }
- `exafyltd/vitana-v1:apps/mobile/src/shell/components` — OverlayHost.tsx is NOT listed here — it is in src/shell/ directly, not src/shell/components/

Suggestion: Ensure the lane's `paths` list for `utility-bar` includes `apps/mobile/src/shell/OverlayHost.tsx` (not `src/shell/components/OverlayHost.tsx`). The plan body already says 'OverlayHost.tsx' without a subdirectory, so this is likely just an omission in the internal path references — verify the lane file is correct.

### R2-F2 [minor]

The plan's decision 6 says 'the route is public, src/App.tsx:877' citing the web app to justify that `/i/:code` doesn't need auth. On native, the route's public-ness depends on it being under `app/(public)/`. At the pinned commit, `app/(public)/i/` does not exist — it is expected from PR #1553 which the plan says is merged at `a763b4f01`. The plan should explicitly state that this lane creates `app/(public)/i/[code].tsx` (if #1553 didn't deliver it) or that the lane verifies it exists from #1553 before proceeding. The current `app/(public)/` directory has no `i/` subdirectory at the pinned commit.

- `exafyltd/vitana-v1:apps/mobile/app/(public)` — Contents: _layout.tsx, alkalma.tsx, delete-account.tsx, logout.tsx, maxina.tsx, oauth/, profile/, reset-password.tsx, u/ — no i/ directory
- `exafyltd/vitana-v1:apps/mobile/app/index.tsx:12` — export default function Landing() {
    const { user, loading } = useAuth();
    const { t } = useI18n();
    if (loading) return <DelayedLoader accessibilityLabel={t('common.loading')} />;
    return <Redirect href={user ? '/home' : '/maxina'} />;
  }

Suggestion: The plan's Today section already says '#1553 … `app/(public)/i/[code].tsx`' and the lane table says 'waits #1553'. Add a note in the public-entry lane that if `app/(public)/i/[code].tsx` is not on main when the lane starts, the lane must create it (or the lane is blocked). The current pinned commit confirms it does not yet exist.
