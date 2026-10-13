/**
 * VTID-05165 — disease / condition names in each of the 11 shipped locales
 * (plan Change 13e). The rendered wellness prompt must contain none of them:
 * the wellness context carries patterns only, never a condition label.
 *
 * Latin and Cyrillic terms match as whole words (case-insensitive); Chinese
 * and Arabic terms match as substrings. A test-side list, not a product
 * vocabulary: the Phase 4 output guard owns the runtime check.
 */
export const CONDITION_DENYLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  en: ['diabetes', 'prediabetes', 'insomnia', 'hypertension', 'hypotension', 'depression', 'anxiety disorder', 'sleep apnea', 'apnoea', 'obesity', 'arrhythmia', 'atrial fibrillation', 'heart failure', 'heart disease', 'dementia', 'cancer', 'tachycardia', 'bradycardia', 'low-hrv'],
  de: ['Diabetes', 'Schlaflosigkeit', 'Insomnie', 'Bluthochdruck', 'Hypertonie', 'Depression', 'Angststörung', 'Schlafapnoe', 'Adipositas', 'Herzrhythmusstörung', 'Vorhofflimmern', 'Herzinsuffizienz', 'Herzschwäche', 'Demenz', 'Krebs'],
  es: ['diabetes', 'insomnio', 'hipertensión', 'depresión', 'trastorno de ansiedad', 'apnea del sueño', 'obesidad', 'arritmia', 'fibrilación auricular', 'insuficiencia cardíaca', 'demencia', 'cáncer'],
  fr: ['diabète', 'insomnie', 'hypertension', 'dépression', 'trouble anxieux', 'apnée du sommeil', 'obésité', 'arythmie', 'fibrillation auriculaire', 'insuffisance cardiaque', 'démence', 'cancer'],
  pt: ['diabetes', 'insónia', 'insônia', 'hipertensão', 'depressão', 'transtorno de ansiedade', 'apneia do sono', 'obesidade', 'arritmia', 'fibrilhação auricular', 'fibrilação atrial', 'insuficiência cardíaca', 'demência', 'cancro', 'câncer'],
  pl: ['cukrzyca', 'bezsenność', 'nadciśnienie', 'depresja', 'zaburzenia lękowe', 'bezdech senny', 'otyłość', 'arytmia', 'migotanie przedsionków', 'niewydolność serca', 'demencja', 'nowotwór', 'rak'],
  sr: ['dijabetes', 'nesanica', 'insomnija', 'hipertenzija', 'depresija', 'anksiozni poremećaj', 'apneja', 'gojaznost', 'aritmija', 'fibrilacija pretkomora', 'srčana insuficijencija', 'demencija', 'rak', 'дијабетес', 'несаница', 'хипертензија', 'депресија', 'апнеја', 'гојазност', 'аритмија', 'деменција', 'рак'],
  ru: ['диабет', 'бессонница', 'инсомния', 'гипертония', 'гипертензия', 'депрессия', 'тревожное расстройство', 'апноэ', 'ожирение', 'аритмия', 'фибрилляция предсердий', 'сердечная недостаточность', 'деменция', 'рак'],
  tr: ['diyabet', 'şeker hastalığı', 'uykusuzluk', 'insomnia', 'hipertansiyon', 'depresyon', 'anksiyete bozukluğu', 'uyku apnesi', 'obezite', 'aritmi', 'atriyal fibrilasyon', 'kalp yetmezliği', 'demans', 'kanser'],
  zh: ['糖尿病', '失眠', '高血压', '抑郁', '焦虑症', '睡眠呼吸暂停', '肥胖', '心律失常', '房颤', '心力衰竭', '痴呆', '癌'],
  ar: ['السكري', 'الأرق', 'ارتفاع ضغط الدم', 'الاكتئاب', 'اضطراب القلق', 'انقطاع النفس', 'السمنة', 'عدم انتظام ضربات القلب', 'الرجفان الأذيني', 'قصور القلب', 'الخرف', 'السرطان'],
});

const SUBSTRING_LOCALES = new Set(['zh', 'ar']);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every denylisted term found in `text`, as `<locale>:<term>`. */
export function findConditionTerms(text: string): string[] {
  const hits: string[] = [];
  for (const [locale, terms] of Object.entries(CONDITION_DENYLIST)) {
    for (const term of terms) {
      const re = SUBSTRING_LOCALES.has(locale)
        ? new RegExp(escape(term), 'u')
        : new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'iu');
      if (re.test(text)) hits.push(`${locale}:${term}`);
    }
  }
  return hits;
}
