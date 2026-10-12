/**
 * VTID-05074 — public privacy, terms and support pages for the Vitanaland
 * Commerce plugin listing (OpenAI's plugin portal fetches them without running
 * JavaScript, and the app's own /privacy and /terms are the Maxina app's
 * documents, rendered client-side).
 *
 *   GET /legal/vitanaland-commerce/privacy
 *   GET /legal/vitanaland-commerce/terms
 *   GET /legal/vitanaland-commerce/support
 *
 * Static English HTML built from the constants below: no database, no env, no
 * user input, no script, no inline style, no external resource. Always on —
 * a legal page must not vanish with a feature switch (the Commerce MCP
 * switches do not apply here). Read-only: any other method answers 404.
 */
import { Router, type Request, type Response } from 'express';

const router = Router();

const PORTAL = 'https://vitanaland.com/commerce';
const GENERAL_PRIVACY = 'https://vitanaland.com/privacy';
const GENERAL_TERMS = 'https://vitanaland.com/terms';
const BASE = '/legal/vitanaland-commerce';
const UPDATED = '2026-10-12';

function page(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title} - Vitanaland Commerce</title>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${title}</h1>`,
    `<p>Vitanaland Commerce, operated by EXAFY LTD. Last updated ${UPDATED}.</p>`,
    body,
    '<nav>',
    `<a href="${BASE}/privacy">Privacy</a> | <a href="${BASE}/terms">Terms</a> | <a href="${BASE}/support">Support</a>`,
    '</nav>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

const PRIVACY = page(
  'Privacy for the Vitanaland plugin',
  `<p>This page explains what happens to a supplier's data when they connect an AI assistant, such as ChatGPT, to Vitanaland Commerce. It adds to the general <a href="${GENERAL_PRIVACY}">Vitanaland privacy policy</a>, which covers everything else.</p>
<h2>What the assistant can read and write</h2>
<p>After the supplier signs in with their own Vitanaland account and approves the connection, the assistant can use nine tools on that supplier's own business only: read the onboarding status, create the business, update the company details, add and update products or services, list them, run the automatic business checks, connect an online shop, and submit the business for review after the supplier confirms. Products and services are saved as hidden drafts until the business is reviewed.</p>
<p>The data involved is what the supplier provides: business name and type, company details, products and services, and the results of the business checks.</p>
<h2>What ChatGPT receives</h2>
<p>Only what the tools return to the conversation. The assistant receives a delegated sign-in token that works for these Commerce tools only; it cannot use the rest of Vitanaland.</p>
<h2>What is never handled in the chat</h2>
<p>Passwords, identity documents, bank or payment details and the acceptance of the Partner Terms. These steps happen on Vitanaland, on the supplier's own account, and the assistant cannot do them for the supplier.</p>
<h2>Disconnecting</h2>
<p>A supplier can stop the connection at any time by removing the plugin or its sign-in in ChatGPT, or by contacting us through the <a href="${BASE}/support">support page</a>.</p>
<h2>Contact</h2>
<p>Questions about this page or about your data: <a href="${BASE}/support">support</a>.</p>`,
);

const TERMS = page(
  'Terms for the Vitanaland plugin',
  `<p>These terms add to the general <a href="${GENERAL_TERMS}">Vitanaland terms</a> for suppliers who use an AI assistant, such as ChatGPT, to set up their business on Vitanaland Commerce.</p>
<h2>What the plugin is</h2>
<p>A convenience for describing a business and its products or services in a conversation instead of in a form. Everything it saves is a draft on the supplier's own Vitanaland account until the business is reviewed.</p>
<h2>The supplier is responsible</h2>
<p>The supplier is responsible for the information they give, whether typed by them or prepared by the assistant on their behalf. Please read what the assistant has saved before you confirm anything.</p>
<h2>Confirmation and the Partner Terms</h2>
<p>The assistant cannot accept the Partner Terms for a supplier and cannot submit a business for review without the supplier's confirmation. The Partner Terms and billing details are accepted by the supplier on Vitanaland.</p>
<h2>Contact</h2>
<p>Questions about these terms: <a href="${BASE}/support">support</a>.</p>`,
);

const SUPPORT = page(
  'Support for the Vitanaland plugin',
  `<p>Help with connecting an AI assistant to Vitanaland Commerce, with the status of a business, or with anything on these pages is available through the Vitanaland Commerce portal: <a href="${PORTAL}">${PORTAL}</a>.</p>
<p>Passwords, identity documents and bank details are never needed in a chat; if an assistant asks for them, stop and contact us there.</p>`,
);

const PAGES: Record<string, string> = {
  '/privacy': PRIVACY,
  '/terms': TERMS,
  '/support': SUPPORT,
};

// static legal pages for the plugin listing, intentionally anonymous
router.get(Object.keys(PAGES), (req: Request, res: Response) => { // public-route
  res
    .status(200)
    .set('Cache-Control', 'public, max-age=300')
    .type('text/html; charset=utf-8')
    .send(PAGES[req.path]);
});

export const COMMERCE_PLUGIN_LEGAL_BASE = BASE;
export default router;
