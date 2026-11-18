// Round 2 additions: epics, issues (GitHub sub-issues), dependencies.
const EPICS = [
  { n: 431, title: 'Billing v2', issues: [
    { n: 435, t: 'Credit note PDFs', s: 'done' }, { n: 438, t: 'Multi-currency price lists', s: 'done' },
    { n: 432, t: 'Round tax per line item', s: 'merging', pr: 483 }, { n: 433, t: 'Prorate plan changes mid-cycle', s: 'you', pr: 482 },
    { n: 434, t: 'Store the currency on each invoice', s: 'you', pr: 485, also: 'jonas' }, { n: 436, t: 'Dunning emails', s: 'todo' }, { n: 437, t: 'Accounting export v2', s: 'todo' } ] },
  { n: 440, title: 'Auth hardening', issues: [
    { n: 442, t: 'Rate-limit login attempts', s: 'done' }, { n: 443, t: 'CSP headers', s: 'done' }, { n: 441, t: 'Rotate tokens on privilege change', s: 'you', pr: 476 }, { n: 444, t: 'Audit log for role changes', s: 'todo' } ] },
  { n: 450, title: 'Typed event bus', issues: [
    { n: 452, t: 'Deprecate ctx.legacyDb', s: 'done', pr: 480 }, { n: 451, t: 'Typed channels', s: 'mate', pr: 479, who: 'ines' }, { n: 453, t: 'Remove ctx.legacyDb', s: 'todo' } ] },
];
const EPIC_OF = { 482: 431, 485: 431, 483: 431, 476: 440, 479: 450, 480: 450 };
const DEPENDS = { 482: 485, 485: 492 };   // "Depends on #n" in the brief / stacked base branch
const SLABEL = { done: 'Done', merging: 'Merging', you: 'Needs you', mate: 'Needs a teammate', todo: 'Not started' };
