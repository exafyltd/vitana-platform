/**
 * VTID-02000: Lightweight keyword inference for supplement products.
 *
 * Used by the CJ sync (which ships no structured metadata — just free-text
 * title/description/keywords) and as a Shopify fallback when collection
 * mappings are absent.
 *
 * Design principles:
 *   - Conservative matching. Prefer false negatives over false positives:
 *     a wrong health_goal would pollute the personalization signal far
 *     worse than a missing one.
 *   - No regex lookbehinds (cross-Node-version safe).
 *   - All matching is case-insensitive on a single pre-lowered haystack.
 *   - Exported helpers are pure functions — straightforward to unit-test.
 */

export interface InferredSupplementAttributes {
  health_goals: string[];
  dietary_tags: string[];
  ingredients_primary: string[];
  form?: string;
  certifications: string[];
}

interface KeywordMap {
  [canonical: string]: RegExp;
}

const HEALTH_GOALS: KeywordMap = {
  'better-sleep':     /\b(sleep(?:ing)?|insomnia|bedtime|slumber|melatonin|deep rest)\b/,
  'stress-reduction': /\b(stress|anxiety|calm(?:ing)?|relax(?:ation|ing)?|cortisol|adaptogen)\b/,
  'energy':           /\b(energy|fatigue|tiredness|vitality|stamina|endurance|low energy|anti-?fatigue)\b/,
  'focus':            /\b(focus|concentration|cognitive|cognition|brain(?! fog)|mental clarity|nootropic|alertness|attention)\b/,
  'mood-balance':     /\b(mood|well[\s-]?being|happiness|serotonin|dopamine|emotional balance)\b/,
  'muscle-recovery':  /\b(muscle|recovery|post[\s-]?workout|workout recovery|soreness|exercise recovery)\b/,
  'immune-support':   /\b(immune|immunity|defen[cs]e|natural killer|white blood cell|cold[\s-]?season)\b/,
  'heart-health':     /\b(heart|cardio(?:vascular)?|blood pressure|cholesterol|triglyceride|lipid|circulation)\b/,
  'joint-support':    /\b(joint|cartilage|mobility|flexibility|glucosamine|chondroitin|arthritis)\b/,
  'gut-health':       /\b(gut|digestion|digestive|probiotic|prebiotic|microbiome|bloating|ibs|leaky gut)\b/,
  'bone-health':      /\b(bone|osteo|skeletal|calcium|vitamin k|density)\b/,
  'skin-hair-nails':  /\b(skin|hair|nails|collagen|biotin|elasticity|glow|anti[\s-]?aging)\b/,
  'hormonal-balance': /\b(hormon(?:e|al)|estrogen|progesterone|testosterone|menopause|menstrual|pms)\b/,
  'longevity':        /\b(longevity|healthspan|life\s?extension|anti[\s-]?aging|nad\+?|resveratrol|senescence)\b/,
  'weight-management':/\b(weight(?:\s|-)?(?:loss|management)|fat[\s-]?burn|metabolism|thermogenic|appetite)\b/,
  'adrenal-support':  /\b(adrenal|ashwagandha|rhodiola|cortisol|burnout|holy basil)\b/,
  'jet-lag-recovery': /\b(jet[\s-]?lag|time zone|travel(?:ing)? sleep)\b/,
};

const DIETARY_TAGS: KeywordMap = {
  'vegan':        /\bvegan\b/,
  'vegetarian':   /\bvegetarian\b/,
  'gluten-free':  /\b(gluten[\s-]?free|no gluten)\b/,
  'dairy-free':   /\b(dairy[\s-]?free|lactose[\s-]?free|no dairy)\b/,
  'nut-free':     /\b(nut[\s-]?free|no nuts|peanut[\s-]?free)\b/,
  'soy-free':     /\b(soy[\s-]?free|no soy)\b/,
  'sugar-free':   /\b(sugar[\s-]?free|no (?:added )?sugar|zero sugar)\b/,
  'organic':      /\b(organic|usda organic|eu organic)\b/,
  'non-gmo':      /\b(non[\s-]?gmo|gmo[\s-]?free)\b/,
  'halal':        /\bhalal\b/,
  'kosher':       /\bkosher\b/,
  'keto-friendly':/\b(keto|ketogenic|low[\s-]?carb friendly)\b/,
  'paleo':        /\bpaleo(?:lithic)?\b/,
};

const CERTIFICATIONS: KeywordMap = {
  'gmp-certified':    /\b(gmp|good manufacturing practice)\b/,
  'third-party-tested':/\b(third[\s-]?party tested|independently tested|usp verified)\b/,
  'nsf-certified':    /\bnsf\b/,
  'informed-sport':   /\binformed[\s-]?(?:sport|choice)\b/,
  'vegan-society':    /\bvegan society\b/,
  'ifos-5-star':      /\bifos\b/,
  'usp-verified':     /\busp verified\b/,
};

// Canonical active-ingredient vocabulary, keyed by canonical slug.
// Matches the most common free-text forms used in product copy.
const INGREDIENTS: KeywordMap = {
  'magnesium':            /\bmagnesium\b/,
  'magnesium-glycinate':  /\bmagnesium\s+(?:bis)?glycinate\b/,
  'magnesium-citrate':    /\bmagnesium\s+citrate\b/,
  'magnesium-threonate':  /\bmagnesium\s+(?:l[\s-]?)?threonate\b/,
  'zinc':                 /\bzinc\b/,
  'iron':                 /\biron\b/,
  'iron-bisglycinate':    /\biron\s+(?:bis)?glycinate\b/,
  'calcium':              /\bcalcium\b/,
  'selenium':             /\bselenium\b/,
  'iodine':               /\biodine\b/,
  'vitamin-c':            /\bvitamin\s*c\b|\bascorbic acid\b/,
  'vitamin-d3':           /\b(?:vitamin\s*d3|cholecalciferol)\b/,
  'vitamin-d2':           /\bvitamin\s*d2|ergocalciferol\b/,
  'vitamin-k2':           /\bvitamin\s*k2|menaquinone|mk[\s-]?7\b/,
  'vitamin-b12':          /\b(?:vitamin\s*b12|cobalamin|methylcobalamin|cyanocobalamin)\b/,
  'vitamin-b6':           /\b(?:vitamin\s*b6|pyridoxine|pyridoxal)\b/,
  'folate':               /\b(?:folate|folic acid|methylfolate)\b/,
  'vitamin-a':            /\b(?:vitamin\s*a|retinol|retinyl)\b/,
  'vitamin-e':            /\bvitamin\s*e|tocopherol\b/,
  'omega-3':              /\bomega[\s-]?3\b/,
  'epa':                  /\bepa\b/,
  'dha':                  /\bdha\b/,
  'fish-oil':             /\bfish oil\b/,
  'krill-oil':            /\bkrill oil\b/,
  'algae-oil':            /\balgae oil\b/,
  'coq10':                /\bcoq[\s-]?10|ubiquinol|ubiquinone\b/,
  'nad':                  /\bnad\+?\b|\bnicotinamide riboside\b|\bnmn\b/,
  'resveratrol':          /\bresveratrol\b/,
  'curcumin':             /\bcurcumin|turmeric\b/,
  'quercetin':            /\bquercetin\b/,
  'melatonin':            /\bmelatonin\b/,
  'l-theanine':           /\bl[\s-]?theanine\b|\btheanine\b/,
  'glycine':              /\bglycine\b/,
  'glutamine':            /\bl[\s-]?glutamine\b|\bglutamine\b/,
  'creatine':             /\bcreatine\b/,
  'taurine':              /\btaurine\b/,
  'carnitine':            /\b(?:l[\s-]?)?carnitine|acetyl[\s-]?l[\s-]?carnitine|alcar\b/,
  'caffeine':             /\bcaffeine\b/,
  'ashwagandha':          /\bashwagandha|ksm[\s-]?66\b/,
  'rhodiola':             /\brhodiola(?:\s+rosea)?\b/,
  'holy-basil':           /\bholy basil|tulsi\b/,
  'ginseng':              /\bginseng\b/,
  'panax-ginseng':        /\bpanax\s+ginseng\b/,
  'ginkgo':               /\bginkgo\b/,
  'bacopa':               /\bbacopa\b/,
  'lions-mane':           /\blion'?s mane|hericium\b/,
  'reishi':               /\breishi\b/,
  'cordyceps':            /\bcordyceps\b/,
  'chaga':                /\bchaga\b/,
  'probiotic':            /\bprobiotic|lactobacillus|bifidobacterium\b/,
  'prebiotic':            /\bprebiotic|inulin|fos|gos\b/,
  'collagen':             /\bcollagen(?:\s+peptides?)?\b/,
  'biotin':               /\bbiotin\b/,
  'hyaluronic-acid':      /\bhyaluronic acid\b/,
  'glucosamine':          /\bglucosamine\b/,
  'chondroitin':          /\bchondroitin\b/,
  'msm':                  /\bmsm\b|\bmethylsulfonylmethane\b/,
  '5-htp':                /\b5[\s-]?htp\b/,
};

// Dosage form — single-valued, so the first hit wins in priority order.
const FORMS: Array<[string, RegExp]> = [
  ['softgel',    /\bsoftgel|soft gel\b/],
  ['capsule',    /\bcapsule|caps\b/],
  ['tablet',     /\btablet|tabs\b/],
  ['gummy',      /\bgumm(?:y|ies)\b/],
  ['liquid',     /\b(?:liquid|drops?|dropper|tincture|syrup|elixir)\b/],
  ['powder',     /\bpowder\b/],
  ['spray',      /\bspray\b/],
  ['chewable',   /\bchewable\b/],
  ['lozenge',    /\b(?:lozenge|pastille)\b/],
  ['effervescent',/\beffervescent\b/],
  ['patch',      /\b(?:patch|transdermal)\b/],
];

function matchAll(haystack: string, map: KeywordMap): string[] {
  const hits: string[] = [];
  for (const [tag, rx] of Object.entries(map)) {
    if (rx.test(haystack)) hits.push(tag);
  }
  return hits;
}

/**
 * Infer supplement attributes from product free-text.
 * @param text  Any combination of title, description, keywords, category.
 *              Callers should concatenate with spaces — do not pre-lower.
 */
export function inferSupplementAttributes(text: string): InferredSupplementAttributes {
  const hay = ` ${text.toLowerCase()} `;

  const health_goals = matchAll(hay, HEALTH_GOALS);
  const dietary_tags = matchAll(hay, DIETARY_TAGS);
  const certifications = matchAll(hay, CERTIFICATIONS);

  // Ingredients: prefer the most specific variant per family (e.g. magnesium-glycinate wins over magnesium).
  const rawIngredients = matchAll(hay, INGREDIENTS);
  const ingredients_primary = collapseIngredientFamilies(rawIngredients);

  let form: string | undefined;
  for (const [name, rx] of FORMS) {
    if (rx.test(hay)) { form = name; break; }
  }

  return { health_goals, dietary_tags, ingredients_primary, form, certifications };
}

const INGREDIENT_FAMILIES: Record<string, string[]> = {
  // If any of the specific forms match, drop the generic parent.
  'magnesium':  ['magnesium-glycinate', 'magnesium-citrate', 'magnesium-threonate'],
  'iron':       ['iron-bisglycinate'],
  'vitamin-b12':[], // cobalamin variants already collapse to vitamin-b12
};

function collapseIngredientFamilies(ings: string[]): string[] {
  const set = new Set(ings);
  for (const [parent, children] of Object.entries(INGREDIENT_FAMILIES)) {
    if (children.some((c) => set.has(c))) set.delete(parent);
  }
  return [...set];
}
