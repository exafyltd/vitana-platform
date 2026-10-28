-- VTID-02000: Backfill demo supplement catalog with real images + richer descriptions.
--
-- Background: the original seed (20260416200000) inserted 10 demo products with
-- one-sentence descriptions and no images[]. On the community app this meant
-- every product card rendered the same category-gradient placeholder, and the
-- drawer "About this product" section was one sentence long.
--
-- This migration populates:
--   - products.images  (3 Unsplash URLs per row; lead image picked to match form/ingredient)
--   - products.description (3-paragraph quality copy: What it is / How it works / How to take)
--
-- Idempotent: uses source_product_id as the match key. Re-running simply
-- re-applies the same content. No rows are inserted or deleted.
--
-- Unsplash URLs chosen from photos already referenced elsewhere in the Vitana
-- codebase (community app mock data), so they're known-reachable public assets.

BEGIN;

-- -----------------------------------------------------------------------------
-- Helper: per-product backfill rows
-- -----------------------------------------------------------------------------
WITH backfill(sku, description, images) AS (
  VALUES
    -- demo-sku-001 Magnesium Glycinate 300mg
    (
      'demo-sku-001',
      E'Bioavailable magnesium glycinate delivers 300mg of elemental magnesium per capsule, chelated to two glycine molecules for gentle absorption without the digestive upset common to oxide or citrate forms.\n\nMagnesium is a cofactor in over 300 enzymatic reactions. The glycinate form crosses the blood–brain barrier more readily than other salts, which is why it''s the go-to choice for sleep quality, calm-wakefulness, and post-exercise muscle recovery. Clinical studies show meaningful improvements in sleep-onset latency and deep-sleep duration in magnesium-insufficient adults.\n\nTake 1–2 capsules 30–60 minutes before bed with water. Pairs well with L-Theanine or glycine. If you take prescription medications (especially antibiotics, diuretics, or thyroid meds), space this supplement at least 2 hours apart.',
      ARRAY[
        'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1550572017-edd951b55104?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1471864190281-a93a3070b6de?w=800&h=800&fit=crop'
      ]
    ),

    -- demo-sku-002 L-Theanine 200mg
    (
      'demo-sku-002',
      E'Pure L-Theanine extracted from green-tea leaves (Camellia sinensis). 200mg per capsule — the dose used in most clinical studies on calm-focus and stress resilience.\n\nL-Theanine increases alpha-wave activity in the brain, the same pattern seen during mindful meditation. The result is a relaxed-but-alert state: you feel composed under pressure without sedation. It works especially well when paired with caffeine (2:1 ratio of L-Theanine to caffeine) to smooth out the jittery edges while preserving alertness.\n\nTake 1 capsule 30 minutes before a demanding task, a stressful call, or as needed during the day. Non-habit-forming and safe to combine with most nootropic stacks. Can also be taken 1 hour before bed to ease sleep onset without morning grogginess.',
      ARRAY[
        'https://images.unsplash.com/photo-1471864190281-a93a3070b6de?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1615485500834-bc10199bc727?w=800&h=800&fit=crop'
      ]
    ),

    -- demo-sku-003 Melatonin 0.3mg — Low-Dose
    (
      'demo-sku-003',
      E'Low-dose melatonin at 0.3mg — the physiological dose that matches the amount your pineal gland naturally releases at night. Most commercial products dose 3–10mg, which is 10–30× more than the body produces and often leaves users groggy the next morning.\n\nMelatonin is the hormone that tells your body it''s biological night. Low-dose supplementation restores the signal without overwhelming the system, making it especially useful for jet lag, shift work, or age-related melatonin decline (production drops roughly 50% from age 20 to age 60). Unlike high-dose melatonin, 0.3mg rarely causes vivid dreams, next-day fog, or tolerance build-up.\n\nTake 1 tablet 30–60 minutes before your target bedtime. For jet lag, take at local bedtime for 3–5 nights. Not recommended for pregnancy, nursing, or children without a clinician''s guidance.',
      ARRAY[
        'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1596363505729-4190a9506133?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&h=800&fit=crop'
      ]
    ),

    -- demo-sku-004 Ashwagandha KSM-66 600mg
    (
      'demo-sku-004',
      E'Clinically-studied KSM-66 ashwagandha — the most researched full-spectrum root extract on the market, standardized to 5% withanolides. 600mg daily is the dose used in the majority of published trials on stress, cortisol, and sleep.\n\nAshwagandha is a classical adaptogen from Ayurveda, meaning it helps the body modulate its stress response rather than blunting it. Published randomized trials show measurable reductions in perceived stress, serum cortisol, and anxiety scores over 8–12 weeks, with secondary benefits for sleep quality, strength, and VO2 max. KSM-66 specifically preserves the natural alkaloid profile of the root through a water-only extraction — no alcohol residue.\n\nTake 1 capsule with breakfast or dinner. Effects are cumulative; most users notice changes after 2–4 weeks of consistent daily use. Skip or consult a clinician if you have autoimmune conditions, thyroid disease, or are on sedatives — ashwagandha can potentiate some medications.',
      ARRAY[
        'https://images.unsplash.com/photo-1615485500834-bc10199bc727?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1471864190281-a93a3070b6de?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1550572017-edd951b55104?w=800&h=800&fit=crop'
      ]
    ),

    -- demo-sku-005 Rhodiola Rosea 500mg
    (
      'demo-sku-005',
      E'Premium Rhodiola Rosea root extract standardized to 3% rosavins and 1% salidroside — the ratio that most closely reflects the intact plant and the dose windows used in Scandinavian and Russian clinical research.\n\nRhodiola is an adaptogen from the Arctic regions, traditionally used by Viking warriors and Himalayan sherpas for endurance and mental stamina. Where ashwagandha is calming, Rhodiola is energizing — it shines in scenarios of physical or cognitive fatigue, low mood with low energy, or high-workload burnout. Trials show improved Pittsburgh Sleep Quality Index scores, reduced fatigue in shift workers, and better performance on cognitive tests under stress.\n\nTake 1 capsule in the morning with breakfast. Avoid taking after 3pm — some people find Rhodiola too stimulating before bed. Stack well with magnesium glycinate (at night) for an energy-by-day / recovery-by-night rhythm.',
      ARRAY[
        'https://images.unsplash.com/photo-1550572017-edd951b55104?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1615485500834-bc10199bc727?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1471864190281-a93a3070b6de?w=800&h=800&fit=crop'
      ]
    ),

    -- demo-sku-006 Vitamin B12 (Methylcobalamin) 1000mcg
    (
      'demo-sku-006',
      E'Vitamin B12 as methylcobalamin — the bioactive, methylated form that crosses the blood–brain barrier and is usable by the body without prior liver conversion. 1000mcg per capsule.\n\nB12 is essential for red blood cell formation, myelin sheath integrity around nerves, and the methylation cycle that regulates DNA repair and neurotransmitter synthesis. Vegans, older adults, and people on metformin or proton-pump inhibitors are at particular risk of deficiency. Low B12 shows up as fatigue, pins-and-needles, mood changes, or cognitive fog long before it shows in a standard blood panel. Methylcobalamin is preferred over the synthetic cyanocobalamin form, especially for those with MTHFR gene variants.\n\nTake 1 capsule with breakfast. Highly water-soluble — excess is excreted in urine — so toxicity risk is effectively zero. If you''re symptomatic for deficiency, ask your clinician for a serum B12 + methylmalonic acid test to confirm.',
      ARRAY[
        'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1596363505729-4190a9506133?w=800&h=800&fit=crop'
      ]
    ),

    -- demo-sku-007 Vitamin D3 4000 IU
    (
      'demo-sku-007',
      E'Vegan Vitamin D3 (cholecalciferol) sourced from lichen rather than the more common lanolin (sheep wool). 4000 IU per daily drop — a dose targeted at adults with limited sun exposure or confirmed low baseline levels.\n\nVitamin D is technically a steroid hormone that regulates over 200 genes, including immune cells, bone remodelling, and mood circuits. Populations living above the 40th parallel (most of Europe, Canada, northern US) cannot synthesize meaningful D3 from sunlight between October and March — deficiency is the norm, not the exception, and it correlates with worse outcomes across respiratory infections, depression, autoimmune conditions, and stress fractures. 4000 IU is the daily upper limit recognized as safe for adults without medical supervision.\n\nTake 1 drop with a fat-containing meal (D3 is fat-soluble). Pair with Vitamin K2 (MK-7) to direct calcium into bones rather than soft tissue. Ideally re-test blood 25(OH)D after 3 months and adjust dose to keep levels in 75–125 nmol/L.',
      ARRAY[
        'https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1596363505729-4190a9506133?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&h=800&fit=crop'
      ]
    ),

    -- demo-sku-008 Iron Bisglycinate 25mg
    (
      'demo-sku-008',
      E'Gentle iron as ferrous bisglycinate — iron chelated to two glycine molecules. The chelation protects the iron from oxidative interaction with stomach mucosa, which is why this form almost never causes the constipation, nausea, or metallic taste typical of iron sulphate.\n\nIron deficiency is the most common nutrient deficiency in the world, especially among menstruating women, endurance athletes, vegetarians, and anyone with a GI absorption issue. Symptoms — fatigue, breathlessness on stairs, cold hands and feet, hair thinning, restless legs — often precede frank anaemia by months. Bisglycinate absorbs 2–4× better than iron sulphate on an empty stomach and is tolerable for people who''ve previously given up on iron supplementation.\n\nTake 1 capsule on an empty stomach with Vitamin C (doubles absorption). Avoid taking with dairy, coffee, tea, or calcium supplements within a 2-hour window. If you''re pregnant, have haemochromatosis, or on thyroid medication, confirm with a clinician first.',
      ARRAY[
        'https://images.unsplash.com/photo-1596363505729-4190a9506133?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&h=800&fit=crop'
      ]
    ),

    -- demo-sku-009 Omega-3 EPA/DHA 1200mg
    (
      'demo-sku-009',
      E'Wild-caught fish oil delivering 1200mg combined EPA + DHA per serving, molecularly distilled for purity (below IFOS limits for mercury, PCBs, and dioxins) and triglyceride-bound rather than the cheaper ethyl-ester form.\n\nEPA and DHA are long-chain omega-3 fatty acids that the body cannot efficiently synthesize from plant precursors. They integrate into every cell membrane and modulate inflammation, cardiovascular function, and brain signalling. Cardiology guidelines recommend 1–2g/day EPA+DHA for people with elevated triglycerides or established cardiovascular disease. DHA specifically makes up roughly 15% of the brain''s dry weight — low levels correlate with worse outcomes in mood disorders, cognitive decline, and ADHD.\n\nTake 2 softgels with the largest meal of the day (fat-soluble). Keep refrigerated after opening to slow oxidation. Not suitable for vegans — an algae-based DHA alternative is in development.',
      ARRAY[
        'https://images.unsplash.com/photo-1499125562588-29fb8a56b5d5?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1596363505729-4190a9506133?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=800&h=800&fit=crop'
      ]
    ),

    -- demo-sku-010 Sleep & Calm Stack
    (
      'demo-sku-010',
      E'A three-ingredient stack formulated for the most common sleep complaint: racing mind at bedtime. Each serving delivers 300mg Magnesium Glycinate, 1g Glycine, and 200mg L-Theanine — the doses most frequently cited in sleep-quality literature.\n\nEach component targets a different axis of sleep. Magnesium glycinate calms the nervous system and supports GABA tone. Glycine lowers core body temperature — a key trigger for deep-sleep onset — and has been shown in controlled trials to improve subjective sleep quality and reduce daytime sleepiness. L-Theanine quiets pre-sleep mental chatter by increasing alpha-wave activity. Together they cover the "can''t fall asleep" and "wake at 3am" patterns without the next-day grogginess of antihistamines or high-dose melatonin.\n\nTake 1 serving 30–60 minutes before bed with water. Safe for nightly use and non-habit-forming. If you take SSRIs, benzodiazepines, or sleep prescriptions, space this stack at least 2 hours apart and discuss with your clinician.',
      ARRAY[
        'https://images.unsplash.com/photo-1596363505729-4190a9506133?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&h=800&fit=crop',
        'https://images.unsplash.com/photo-1471864190281-a93a3070b6de?w=800&h=800&fit=crop'
      ]
    )
)
UPDATE public.products AS p
SET
  description = b.description,
  images      = b.images,
  updated_at  = now()
FROM backfill b
WHERE p.source_network = 'demo_seed'
  AND p.source_product_id = b.sku;

COMMIT;
