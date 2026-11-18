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
// Round 3: last activity per PR [minutes ago, what happened, clock time for yesterday]
const ACT = { 493: [6, 'fix pushed for the failing check'], 481: [12, 'opened'], 491: [25, 'new commit · your signature dropped'], 489: [35, 'merged'],
  490: [50, 'opened by your agent'], 487: [60, 'merged'], 488: [70, 'checks turned green'], 482: [100, 'Jonas’s agent asked you to review'], 486: [120, 'merged'],
  485: [140, '2 new commits'], 478: [180, 'Ines signed'], 492: [240, 'opened'], 483: [270, 'you signed · checks running'], 476: [315, 'rebased · Jonas’s signature held'],
  484: [368, 'merged'], 477: [1155, 'merged', '19:05'], 480: [1189, 'merged', '18:31'], 479: [1370, 'you signed · waits on Ines', '15:30'] };
