import type { CatalogRow } from '../matcher/catalog-matcher';

export interface ComposerInput {
  question_body: string;
  match: CatalogRow;
  user_disclosure: string;
  personal_voice_sample?: string;
}

export interface ComposerOutput {
  reply_body: string;
  includes_disclosure: boolean;
  includes_non_affiliate_alt: boolean;
  composer_version: string;
}

const COMPOSER_VERSION = 'v0-template';

export function composeDraft(input: ComposerInput): ComposerOutput {
  const { match, user_disclosure } = input;
  const note = match.personal_note?.trim();
  const title = match.title;
  const url = match.affiliate_url;

  const lead = note
    ? note
    : match.tier === 'own'
      ? `${title} is something I put together for exactly this.`
      : match.vetting_status === 'endorsed'
        ? `I've tried ${title} and it holds up.`
        : match.vetting_status === 'tried'
          ? `I've used ${title} — worth a look.`
          : `${title} is worth looking at.`;

  const includeAlt = match.tier === 'affiliate_network';
  const altLine = includeAlt
    ? " If you'd rather skip the affiliate link, search the product name directly and buy from the retailer."
    : '';

  const reply_body = `${lead} Link: ${url}\n\n${user_disclosure}${altLine}`;

  return {
    reply_body,
    includes_disclosure: true,
    includes_non_affiliate_alt: includeAlt,
    composer_version: COMPOSER_VERSION,
  };
}
