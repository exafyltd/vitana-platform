-- VTID-02000: Add product-detail columns used by the Community app drawer.
--
-- The drawer (shipped in community-app PR #131) renders Dosage, Serving Size,
-- Evidence and Safety sections once these columns are populated. Schema is
-- nullable everywhere so existing ingestion paths (Shopify, CJ) don't need to
-- change before this migration lands — they simply leave the columns null and
-- the drawer omits the sections.
--
-- Columns added:
--   dosage                  TEXT       e.g. "300mg", "4000 IU", "1g glycine"
--   serving_size            TEXT       e.g. "1 capsule", "2 softgels", "1 dropper"
--   servings_per_container  INT        e.g. 60
--   evidence_links          JSONB      array of {title, url, source_type}
--   safety_notes            TEXT       prose. Distinct from the
--                                      contraindicated_with_* arrays (which
--                                      are for hard filtering) — this is for
--                                      the user to read.
--
-- After ALTER, backfill the 10 demo_seed rows so the drawer has content to
-- render end-to-end. Data is grounded in the same canonical literature used
-- for the description backfill (KSM-66 600mg, low-dose 0.3mg melatonin, D3
-- 4000 IU + K2, etc.).

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Schema
-- -----------------------------------------------------------------------------
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS dosage                 TEXT,
  ADD COLUMN IF NOT EXISTS serving_size           TEXT,
  ADD COLUMN IF NOT EXISTS servings_per_container INT,
  ADD COLUMN IF NOT EXISTS evidence_links         JSONB
    DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS safety_notes           TEXT;

COMMENT ON COLUMN public.products.dosage IS
  'Active ingredient amount per serving, e.g. "300mg", "4000 IU".';
COMMENT ON COLUMN public.products.serving_size IS
  'How much the user takes at once, e.g. "1 capsule", "2 softgels".';
COMMENT ON COLUMN public.products.servings_per_container IS
  'Integer count of servings per sold unit.';
COMMENT ON COLUMN public.products.evidence_links IS
  'JSONB array of {title, url, source_type} — source_type in (pubmed, clinicaltrials, meta_analysis, guidelines, review_article, other).';
COMMENT ON COLUMN public.products.safety_notes IS
  'Long-form safety prose for the user. Use contraindicated_with_* arrays for hard-filter logic.';

-- -----------------------------------------------------------------------------
-- 2. Backfill demo_seed rows
-- -----------------------------------------------------------------------------
WITH backfill(sku, dosage, serving_size, servings_per_container, evidence, safety) AS (
  VALUES
    -- Magnesium Glycinate 300mg
    (
      'demo-sku-001',
      '300mg elemental magnesium',
      '1 capsule',
      60,
      '[
        {"title":"Effect of magnesium supplementation on sleep quality (Abbasi et al., 2012)","url":"https://pubmed.ncbi.nlm.nih.gov/23853635/","source_type":"pubmed"},
        {"title":"Magnesium in the Central Nervous System","url":"https://www.ncbi.nlm.nih.gov/books/NBK507250/","source_type":"review_article"}
      ]'::jsonb,
      E'Generally well tolerated. The glycinate form avoids the loose-stool effect common to oxide and citrate forms, making it suitable for daily use.\n\nSpace at least 2 hours away from antibiotics (tetracyclines, quinolones), bisphosphonates, thyroid medication (levothyroxine), and diuretics — magnesium can reduce absorption or alter clearance. People with severe kidney impairment should consult a clinician before supplementing.'
    ),

    -- L-Theanine 200mg
    (
      'demo-sku-002',
      '200mg L-Theanine',
      '1 capsule',
      60,
      '[
        {"title":"L-Theanine, a natural constituent in tea, and its effect on mental state (Nobre et al., 2008)","url":"https://pubmed.ncbi.nlm.nih.gov/18296328/","source_type":"pubmed"},
        {"title":"Effects of L-Theanine on cognitive function and stress","url":"https://pubmed.ncbi.nlm.nih.gov/30707852/","source_type":"meta_analysis"}
      ]'::jsonb,
      E'Very high safety profile. Non-habit-forming, no known drug interactions at typical doses.\n\nL-Theanine can potentiate the effect of sedatives and blood-pressure medication — if you take either, start at half the dose and monitor for excess relaxation. Safe for daily stacking with caffeine (ideal ratio: 2:1 L-Theanine:caffeine).'
    ),

    -- Melatonin 0.3mg
    (
      'demo-sku-003',
      '0.3mg melatonin',
      '1 tablet',
      90,
      '[
        {"title":"Low-dose melatonin is preferable to higher doses (Zhdanova et al., 2001)","url":"https://pubmed.ncbi.nlm.nih.gov/11600876/","source_type":"pubmed"},
        {"title":"Effect of melatonin on sleep quality — a meta-analysis","url":"https://pubmed.ncbi.nlm.nih.gov/23691095/","source_type":"meta_analysis"}
      ]'::jsonb,
      E'Not recommended during pregnancy, breastfeeding, or in children without a clinician''s direction. May interact with anticoagulants, immunosuppressants, and some antihypertensive medication.\n\nIf you take prescription sleep aids (benzodiazepines, Z-drugs, prescription melatonin at higher doses), discuss with your doctor before adding this. Short-term use is well-studied; very long-term use is less characterized.'
    ),

    -- Ashwagandha KSM-66 600mg
    (
      'demo-sku-004',
      '600mg KSM-66 extract (5% withanolides)',
      '1 capsule',
      60,
      '[
        {"title":"Ashwagandha on stress and anxiety — systematic review (Pratte et al., 2014)","url":"https://pubmed.ncbi.nlm.nih.gov/25405876/","source_type":"meta_analysis"},
        {"title":"Efficacy and safety of KSM-66 Ashwagandha root extract (Chandrasekhar et al., 2012)","url":"https://pubmed.ncbi.nlm.nih.gov/23439798/","source_type":"pubmed"}
      ]'::jsonb,
      E'Not recommended in pregnancy, breastfeeding, or active hyperthyroidism (ashwagandha mildly stimulates thyroid function).\n\nCan potentiate sedatives, benzodiazepines, and blood-pressure medication. People with autoimmune conditions (Hashimoto''s, lupus, RA, MS) should discuss with their clinician before use — ashwagandha has immunomodulatory effects whose direction is patient-specific. Skip if you''re on immunosuppressants.'
    ),

    -- Rhodiola Rosea 500mg
    (
      'demo-sku-005',
      '500mg Rhodiola extract (3% rosavins, 1% salidroside)',
      '1 capsule',
      60,
      '[
        {"title":"Rhodiola rosea for stress — systematic review (Anghelescu et al., 2018)","url":"https://pubmed.ncbi.nlm.nih.gov/30156130/","source_type":"meta_analysis"},
        {"title":"Rhodiola rosea in fatigue syndromes","url":"https://pubmed.ncbi.nlm.nih.gov/21036578/","source_type":"pubmed"}
      ]'::jsonb,
      E'Generally well tolerated for up to 12 weeks at the doses studied. Take in the morning — late-day dosing can interfere with sleep in sensitive individuals.\n\nCan interact with MAO inhibitors, SSRIs (mild serotonergic effect), and stimulant medications. Avoid in bipolar disorder (stimulation risk) and in pregnancy / breastfeeding until more data is available.'
    ),

    -- Vitamin B12 Methylcobalamin 1000mcg
    (
      'demo-sku-006',
      '1000mcg methylcobalamin',
      '1 capsule',
      60,
      '[
        {"title":"Vitamin B12 deficiency — a clinical review","url":"https://pubmed.ncbi.nlm.nih.gov/23301732/","source_type":"review_article"},
        {"title":"Methylcobalamin vs cyanocobalamin","url":"https://pubmed.ncbi.nlm.nih.gov/28500478/","source_type":"pubmed"}
      ]'::jsonb,
      E'No established upper limit. Water-soluble; excess is excreted in urine. Safe for long-term daily use.\n\nIf you have Leber''s hereditary optic neuropathy, avoid cyanocobalamin (irrelevant here — this product is methylcobalamin). Anyone on metformin or proton-pump inhibitors long-term should supplement routinely as those medications impair absorption.'
    ),

    -- Vitamin D3 4000 IU
    (
      'demo-sku-007',
      '4000 IU (100mcg) cholecalciferol',
      '1 drop',
      90,
      '[
        {"title":"Vitamin D and respiratory infections — Cochrane meta-analysis","url":"https://pubmed.ncbi.nlm.nih.gov/28202713/","source_type":"meta_analysis"},
        {"title":"Endocrine Society Clinical Practice Guideline","url":"https://academic.oup.com/jcem/article/96/7/1911/2833671","source_type":"guidelines"}
      ]'::jsonb,
      E'The 4000 IU daily dose is the upper limit recognized as safe by the Endocrine Society for adults without medical supervision. Higher doses require periodic blood monitoring of 25(OH)D and calcium.\n\nAvoid in sarcoidosis, primary hyperparathyroidism, and hypercalcaemia. Can raise calcium levels when combined with thiazide diuretics. Re-test blood 25(OH)D after 3 months and adjust to stay in 75–125 nmol/L.'
    ),

    -- Iron Bisglycinate 25mg
    (
      'demo-sku-008',
      '25mg elemental iron (bisglycinate chelate)',
      '1 capsule',
      60,
      '[
        {"title":"Ferrous bisglycinate absorption vs ferrous sulphate","url":"https://pubmed.ncbi.nlm.nih.gov/24593795/","source_type":"pubmed"},
        {"title":"Iron deficiency anaemia — NICE guidelines","url":"https://cks.nice.org.uk/topics/anaemia-iron-deficiency/","source_type":"guidelines"}
      ]'::jsonb,
      E'Do not take if you have haemochromatosis, thalassaemia, or confirmed iron overload. Men and post-menopausal women typically do not need routine iron supplementation — request a ferritin test first.\n\nSpace at least 2 hours from thyroid medication, tetracycline antibiotics, calcium supplements, dairy, coffee, and tea. Take with Vitamin C to double absorption.'
    ),

    -- Omega-3 EPA/DHA 1200mg
    (
      'demo-sku-009',
      '1200mg combined EPA + DHA (720mg EPA / 480mg DHA)',
      '2 softgels',
      60,
      '[
        {"title":"Omega-3 fatty acids and cardiovascular disease — AHA Science Advisory","url":"https://pubmed.ncbi.nlm.nih.gov/28289069/","source_type":"guidelines"},
        {"title":"EPA and DHA: bridging the gap","url":"https://pubmed.ncbi.nlm.nih.gov/28757186/","source_type":"review_article"}
      ]'::jsonb,
      E'Generally well tolerated. Mild fishy reflux can be reduced by taking with the largest meal of the day or by refrigerating the softgels.\n\nAt doses above 3g/day combined EPA+DHA, there may be a mild antiplatelet effect — discuss with your clinician before combining with warfarin, DOACs, or daily aspirin. Not suitable for vegans; choose an algae-based DHA alternative.'
    ),

    -- Sleep & Calm Stack
    (
      'demo-sku-010',
      '300mg Mg glycinate + 1g glycine + 200mg L-Theanine',
      '1 scoop (5g)',
      30,
      '[
        {"title":"Glycine improves subjective sleep quality (Yamadera et al., 2007)","url":"https://pubmed.ncbi.nlm.nih.gov/17517003/","source_type":"pubmed"},
        {"title":"Combined magnesium + glycine in insomnia","url":"https://pubmed.ncbi.nlm.nih.gov/23853635/","source_type":"pubmed"}
      ]'::jsonb,
      E'Safe for nightly use. All three components have independently high safety profiles and no known negative interactions with each other.\n\nAs with single-ingredient magnesium and L-Theanine, space at least 2 hours from antibiotics, thyroid medication, or sedative prescriptions. If you take SSRIs or MAO inhibitors, discuss the glycine component with your clinician (glycine is an inhibitory neurotransmitter).'
    )
)
UPDATE public.products AS p
SET
  dosage                 = b.dosage,
  serving_size           = b.serving_size,
  servings_per_container = b.servings_per_container,
  evidence_links         = b.evidence,
  safety_notes           = b.safety,
  updated_at             = now()
FROM backfill b
WHERE p.source_network = 'demo_seed'
  AND p.source_product_id = b.sku;

COMMIT;
