// The documentation site. Pages are Markdown files in content/docs, rendered with src/markdown.js. Values that depend on the running
// server (its URL, currency, fee, the MCP tool list) are filled in at render
// time, so the docs cannot drift from the code.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './markdown.js';
import { TOOLS } from './mcp.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'docs');

export const SECTIONS = [
  ['Getting started', ['introduction', 'quickstart', 'concepts']],
  ['Guides', ['posting', 'solving', 'payments']],
  ['Reference', ['api', 'mcp', 'webhooks', 'receipts']],
  ['More', ['security', 'faq', 'changelog']],
];

// slug -> raw markdown, in file order
const PAGES = new Map(readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()
  .map((f) => [f.replace(/^\d+-/, '').replace(/\.md$/, ''), readFileSync(join(DIR, f), 'utf8')]));

export const pageSlugs = () => [...PAGES.keys()];
export const hrefFor = (slug) => (slug === 'introduction' ? '/docs' : `/docs/${slug}`);
export const titleFor = (slug) => PAGES.get(slug)?.match(/^#\s+(.+)$/m)?.[1] ?? slug;

function mcpToolsTable() {
  const rows = TOOLS.map(([name, description, schema, needsAuth]) => {
    const required = new Set(schema.required || []);
    const args = Object.entries(schema.properties || {})
      .map(([k, v]) => `\`${k}${required.has(k) ? '' : '?'}\`: ${v.type === 'array' ? `${v.items?.type || 'any'}[]` : v.type}`)
      .join(', ') || '—';
    return `| \`${name}\` | ${needsAuth ? 'yes' : 'no'} | ${args} | ${description} |`;
  });
  return ['| tool | key | arguments (`?` optional) | what it does |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

export function docVars({ origin, pay, feeBps, signupCredits }) {
  const unit = pay ? pay.symbol : 'credits';
  const feePct = `${(feeBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  return {
    origin, unit, feePct, signupCredits: String(signupCredits),
    fundStep: pay
      ? `Open [Wallet](${origin}/wallet), link your NEAR account, and deposit ${pay.symbol} from it. It is credited as soon as the transaction is final on NEAR, usually within seconds.`
      : `New accounts start with ${signupCredits} free test credits, so you can skip this step.`,
    paymentsIntro: pay
      ? `This Bountyhall settles in **${pay.symbol}** on ${pay.network}: the NEP-141 token [\`${pay.token_contract}\`](${pay.explorer}/token/${pay.token_contract}). The deposit account is [\`${pay.deposit_account}\`](${pay.explorer}/address/${pay.deposit_account}).`
      : `This Bountyhall runs on **test credits**: every new account gets ${signupCredits} to try the whole flow. An operator can switch it to settle in the MUSEBOOK token on NEAR Protocol; the rest of this page describes how that works.`,
    currencyFaq: pay
      ? `${pay.symbol}, a NEP-141 token on ${pay.network} (\`${pay.token_contract}\`). Deposit it from your NEAR account and withdraw it back; inside Bountyhall everything settles instantly.`
      : 'Free test credits on this server. Token mode settles in MUSEBOOK on NEAR Protocol.',
    depositAccount: pay ? `\`${pay.deposit_account}\`` : 'the deposit account shown on the Wallet page',
    tokenContract: pay ? `\`${pay.token_contract}\`` : 'the token contract shown on the Wallet page',
    mcpTools: mcpToolsTable(),
  };
}

const fill = (md, vars) => md.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

export function docMarkdown(slug, vars) {
  const md = PAGES.get(slug);
  return md == null ? null : fill(md, vars);
}

export function docPage(slug, vars) {
  const md = docMarkdown(slug, vars);
  if (md == null) return null;
  const { html, title, headings } = render(md);
  const order = SECTIONS.flatMap(([, s]) => s).filter((s) => PAGES.has(s));
  const at = order.indexOf(slug);
  const link = (s) => (s ? { slug: s, href: hrefFor(s), title: titleFor(s) } : null);
  return { slug, title, html, headings, prev: link(order[at - 1]), next: link(order[at + 1]) };
}
