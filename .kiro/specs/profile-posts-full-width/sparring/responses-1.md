# Responses — round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct: a plain switch to items-center would change desktop alignment. Plan §Change now uses a two-column grid with items-center on phones and md:items-start from md (today's alignment); the avatar gets md:row-span-2 and the body md:col-start-2, which reproduces today's desktop avatar column. Measured on a local prototype (mocked hooks) at 1400x900: avatar, name, text and media left/top edges are identical to origin/main (341/53, 397/53, 397/87, 397/131). The vertical-centre change is phone-only and is the owner's requested look."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Plan §Change 3 and §Tests now treat the three blocks separately: image = FeedMedia (lines 247-253), video = the raw <video> wrapper div (lines 254-266, not FeedMedia), and the background-style block (line 237) including its own rounded-xl. Each gets its own responsive class string; the test asserts the raw video wrapper separately."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Plan §Tests now lists the full surface: render inside MemoryRouter (useNavigate); mocks for useProfilePosts, usePostInteractions, AuthProvider, useShareOrCopy, useTranslation, i18n-toast, locale-format and a FeedMedia stub; Tooltip/renderMentions/getPostBackground/MentionInput render real (the tab mounts its own TooltipProvider, ProfilePostsTab.tsx:135). Prototype: the test renders without context errors, 4/4 red on origin/main, 4/4 green after."
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Plan §Change 3 now gives the exact before/after class strings: rounding and shadow are applied only with md: prefixes (md:rounded-xl md:shadow-md), the unprefixed rounded-xl/shadow-md are removed rather than reset, and FeedMedia gets w-auto (twMerge overrides its internal w-full via cn, FeedMedia.tsx:453-456) plus md:w-full so -mx-5 widens it."
  }
]
```
