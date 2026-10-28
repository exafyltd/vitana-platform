# Sparring round 1 — in_progress

Session: `fd2711ec-7768-4b2a-afe3-e4c80ba0d2d5` · plan hash `1efe8530fafc9ced1a697c68b974f3b48438edbef60a177f1c6bb458bcd0357a`

## Summary

Verified 7+ premises against the pinned code. The plan's core claims about the parity ledger count (24 rows), IO-freedom of vitanaIndex.ts, App.tsx routes, and assertNotProduction all hold. However, the claim that `health-plans-services` screens are "static/navigational" and "read no health data" is false: Plans.tsx fetches from `user_health_plans` and exposes write mutations, and PillarsOfHealth.tsx imports VitanaIndexValue (likely a health-data read). This undermines the dependency graph, the "reads only" safety guarantee, and the lane partition rationale. Additionally, the plan references `pillarKeys`/`pillarLabel` as exports of vitanaIndex.ts, but they do not exist in that file.

## Findings

### R1-F1 [major]

The plan states `health-plans-services` 'has no dependency on either (its screens are static/navigational — pillars, conditions, education, plans, services hub — and read no health data)'. This is false. Plans.tsx imports useHealthPlans() which reads from `user_health_plans` via Supabase and also exposes three mutations: generatePlan (calls supabase.functions.invoke), updateAdherence (writes to user_health_plans), and logAdherence (writes to plan_adherence_logs). It also uses calculateAutopilotContext which processes health plan data. Plans.tsx is NOT static/navigational — it fetches and processes live health data, and the native port will need the native Supabase client + auth context (the same 'native health-data module' that health-hub owns). This means health-plans-services either depends on health-hub or must independently re-implement health-data fetching, breaking the stated dependency graph.

- `exafyltd/vitana-v1:src/pages/health/Plans.tsx:16` — import { useHealthPlans } from "@/hooks/useHealthPlans";
...
const { plans, isLoading } = useHealthPlans();
- `exafyltd/vitana-v1:src/hooks/useHealthPlans.ts:1` — import { supabase } from '@/integrations/supabase/client';
...
const { data, error } = await supabase.from('user_health_plans').select('*')...
const generatePlan = useMutation({...supabase.functions.invoke('generate-personalized-plan'...)...
const updateAdherence = useMutation({...supabase.from('user_health_plans').update(...)...
const logAdherence = useMutation({...supabase.from('plan_adherence_logs').insert(...)...
- `exafyltd/vitana-v1:src/pages/health/Plans.tsx:25` — import { calculateAutopilotContext } from "@/services/autopilotContext";
...
const autopilotData = useMemo(() => {
  return calculateAutopilotContext(plans || []);
}, [plans]);

Suggestion: Reclassify Plans.tsx as a health-data-reading screen. Either (a) add a dependency from health-plans-services to health-hub so it can consume the native health-data module, or (b) move the Plans screen from health-plans-services into a lane that already owns the native data module. Also clarify how the write mutations (generatePlan, updateAdherence, logAdherence) will be handled in the native port — they contradict the plan's 'reads only' guarantee (program §6). At minimum the native twin must stub or omit the mutations and the plan must say so explicitly.

### R1-F2 [major]

PillarsOfHealth.tsx is also classified under health-plans-services as 'static/navigational' reading 'no health data', but it imports VitanaIndexValue (line 2), a component that almost certainly fetches the live Vitana Index score from Supabase. The non-Spotlight branch (the mobile path the native port targets) renders a VitanaIndexValue inside the header panel. This is another health-data dependency inside the supposedly data-free lane.

- `exafyltd/vitana-v1:src/pages/health/PillarsOfHealth.tsx:1` — import VitanaIndexValue from "@/components/health/VitanaIndexValue";
- `exafyltd/vitana-v1:src/pages/health/PillarsOfHealth.tsx:59` — The non-spotlight (mobile) branch at lines 59-86 renders: <span className="text-xl font-bold text-status-success"><VitanaIndexValue /></span>

Suggestion: Verify whether VitanaIndexValue fetches data (it likely uses useVitanaIndex or similar). If so, PillarsOfHealth needs the native health-data module — either add the dependency or move the screen. If the mobile-web branch (useIsMobile) does NOT render the VitanaIndexValue panel, document that explicitly as a parity exception in the native twin.

### R1-F3 [minor]

The plan says the pure helpers to extract into @vitana/core are 'the Vitana Index tier/label/pillar math (src/lib/vitanaIndex.ts, pillarKeys/pillarLabel/getVitanaIndexTier)'. However, vitanaIndex.ts exports VITANA_INDEX_TIERS, getVitanaIndexTier, nextTier, pointsToNextTier, getVitanaIndexPercentage, and formatVitanaIndexScore. There are no `pillarKeys` or `pillarLabel` exports in this file.

- `exafyltd/vitana-v1:src/lib/vitanaIndex.ts:1` — Exports: VitanaIndexTier (interface), VITANA_INDEX_TIERS, getVitanaIndexTier, nextTier, pointsToNextTier, getVitanaIndexPercentage, formatVitanaIndexScore. No pillarKeys or pillarLabel.

Suggestion: Correct the plan to reference the actual exports of vitanaIndex.ts. If pillarKeys/pillarLabel exist in a different file, cite that file. If they don't exist yet, the plan must note they are new code, not an extraction.

### R1-F4 [major]

useHealthPlans() exposes a generatePlan mutation that calls supabase.functions.invoke('generate-personalized-plan') — a Supabase Edge Function that likely involves server-side LLM invocation. The plan does not address whether the native port of Plans.tsx will include this functionality or how it aligns with the Bedrock-only LLM routing governance rule. The native twin's 'Generate New Plan' button (Plans.tsx line 103-114) and the PlanGeneratorWizard would trigger this function. The plan's 'reads only / no health data is written' claim is directly contradicted by the write mutations in this hook.

- `exafyltd/vitana-v1:src/hooks/useHealthPlans.ts:23` — const generatePlan = useMutation({
  mutationFn: async ({ planType, userContext }: { planType: string; userContext: any }) => {
    const { data, error } = await supabase.functions.invoke('generate-personalized-plan', {
      body: { planType, userContext }
    });
- `exafyltd/vitana-v1:src/hooks/useHealthPlans.ts:40` — const updateAdherence = useMutation({...supabase.from('user_health_plans').update({ adherence_score: score...})...
const logAdherence = useMutation({...supabase.from('plan_adherence_logs').insert({...})...

Suggestion: The plan must explicitly state how write/mutation functionality in Plans.tsx (generatePlan, updateAdherence, logAdherence) is handled in the native twin. Options: (a) the native twin is read-only and stubs/omits the mutations with the generate button disabled or hidden, documented as a 'reads only' constraint, or (b) the mutations are ported and LLM governance for the edge function is verified. Either way, the plan must be explicit. The network-guard test the plan describes (no non-GET) must cover these code paths.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
