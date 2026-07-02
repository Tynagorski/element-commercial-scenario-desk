/* Element Commercial — Commercial Scenario Desk
   Client-side underwriting screen: LTV / DSCR / reserves / experience / credit
   flags, an overall determination, a dynamic document checklist, an optional
   AI narrative (Netlify function, degrades gracefully), and a branded PDF
   export via jsPDF. Nothing here is submitted anywhere — it's a screening tool. */

(() => {
  'use strict';

  const form = document.getElementById('scenario-form-el');
  if (!form) return;

  const resultsSection   = document.getElementById('scenario-results');
  const banner           = document.getElementById('determination-banner');
  const bannerIcon       = document.getElementById('determination-icon');
  const bannerLabel      = document.getElementById('determination-label');
  const bannerSub        = document.getElementById('determination-sub');
  const metricsGrid      = document.getElementById('metrics-grid');
  const flagsList        = document.getElementById('flags-list');
  const narrativeText    = document.getElementById('narrative-text');
  const checklistGroups  = document.getElementById('checklist-groups');
  const checklistProgress     = document.getElementById('checklist-progress');
  const checklistProgressFill = document.getElementById('checklist-progress-fill');
  const checklistProgressLabel= document.getElementById('checklist-progress-label');
  const downloadBtn      = document.getElementById('download-pdf-btn');
  const resetBtn         = document.getElementById('reset-scenario-btn');

  const DETERMINATION_ICON = { strong: '✓', workable: '~', structuring: '!', nonstarter: '✕' };

  const fmtMoney = (n) => {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  };
  const fmtPct = (n, digits = 1) => {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return (n * 100).toFixed(digits) + '%';
  };

  // ── Reference tables ──────────────────────────────────────────
  const PROPERTY_RULES = {
    multifamily: { label: 'Multifamily (5+ units)',          maxLTV: 0.75, minDSCR: 1.20 },
    mixeduse:    { label: 'Mixed-Use',                        maxLTV: 0.70, minDSCR: 1.25 },
    retail:      { label: 'Retail / Strip Center',            maxLTV: 0.70, minDSCR: 1.25 },
    nnn:         { label: 'NNN / Net Lease',                  maxLTV: 0.70, minDSCR: 1.20 },
    office:      { label: 'Office',                           maxLTV: 0.65, minDSCR: 1.25 },
    industrial:  { label: 'Industrial / Warehouse',           maxLTV: 0.70, minDSCR: 1.20 },
    selfstorage: { label: 'Self-Storage',                     maxLTV: 0.75, minDSCR: 1.20 },
    hotel:       { label: 'Hotel / Hospitality',              maxLTV: 0.65, minDSCR: 1.35 },
    medical:     { label: 'Medical Office',                   maxLTV: 0.70, minDSCR: 1.25 },
    mhp:         { label: 'Mobile Home Park',                 maxLTV: 0.70, minDSCR: 1.20 },
    special:     { label: 'Special Purpose',                  maxLTV: 0.60, minDSCR: 1.35 },
    other:       { label: 'Other',                            maxLTV: 0.65, minDSCR: 1.25 }
  };

  const PURPOSE_RULES = {
    purchase:     { label: 'Purchase',                 ltvAdjust: 0,     mode: 'standard' },
    ratetermrefi: { label: 'Rate & Term Refinance',     ltvAdjust: 0.05,  mode: 'standard' },
    cashoutrefi:  { label: 'Cash-Out Refinance',        ltvAdjust: -0.05, mode: 'standard' },
    construction: { label: 'Construction',              ltvAdjust: 0,     mode: 'construction' },
    bridge:       { label: 'Bridge / Short-Term',       ltvAdjust: 0.05,  mode: 'bridge' },
    sba7a:        { label: 'SBA 7(a)',                  ltvAdjust: 0.20,  mode: 'sba' },
    sba504:       { label: 'SBA 504',                   ltvAdjust: 0.20,  mode: 'sba' }
  };

  const SEVERITY_WEIGHT = { green: 0, yellow: 1, red: 3, info: 0 };
  const SEVERITY_ICON   = { green: '✓', yellow: '!', red: '✕', info: 'i' };

  // ── Core math ──────────────────────────────────────────────────
  function monthlyPayment(loanAmount, annualRatePct, years) {
    const mr = (annualRatePct / 100) / 12;
    const n  = years * 12;
    if (loanAmount <= 0 || n <= 0) return 0;
    if (mr === 0) return loanAmount / n;
    return loanAmount * mr * Math.pow(1 + mr, n) / (Math.pow(1 + mr, n) - 1);
  }

  function evaluate(inputs) {
    const propRule = PROPERTY_RULES[inputs.propertyType] || PROPERTY_RULES.other;
    const purpRule = PURPOSE_RULES[inputs.loanPurpose] || PURPOSE_RULES.purchase;

    const price = inputs.price;
    const loanAmount = inputs.loanAmount;
    const ltv = price > 0 ? loanAmount / price : null;
    const maxLTV = Math.min(0.90, Math.max(0, propRule.maxLTV + purpRule.ltvAdjust));

    const rate = inputs.rate || 7.5;
    const amort = inputs.amort || 30;
    const monthlyDebtService = monthlyPayment(loanAmount, rate, amort);
    const annualDebtService = monthlyDebtService * 12;
    const dscr = (inputs.noi && annualDebtService > 0) ? inputs.noi / annualDebtService : null;

    const closingCosts = price * 0.03;
    const equityRequired = purpRule.mode === 'standard' && inputs.loanPurpose === 'purchase'
      ? Math.max(0, price - loanAmount) + closingCosts
      : closingCosts; // refi/bridge/construction: assume costs only, no new cash-in unless cash-out negative
    const reserveRequirement = monthlyDebtService * 6;
    const totalCashNeeded = equityRequired + reserveRequirement;
    const liquidityShortfall = (inputs.liquidity !== null)
      ? Math.max(0, totalCashNeeded - inputs.liquidity)
      : null;

    const flags = [];

    // LTV
    if (ltv !== null) {
      if (ltv > maxLTV + 0.05) {
        flags.push({ key: 'ltv', severity: 'red', title: 'Leverage too high',
          detail: `Requested LTV of ${fmtPct(ltv)} is well above the typical ${fmtPct(maxLTV)} ceiling for ${propRule.label.toLowerCase()} under a ${purpRule.label.toLowerCase()}.` });
      } else if (ltv > maxLTV) {
        flags.push({ key: 'ltv', severity: 'yellow', title: 'Leverage above typical guidelines',
          detail: `Requested LTV of ${fmtPct(ltv)} is above the typical ${fmtPct(maxLTV)} ceiling — expect either a smaller loan amount or a specialty/bridge structure.` });
      } else {
        flags.push({ key: 'ltv', severity: 'green', title: 'Leverage within typical range',
          detail: `Requested LTV of ${fmtPct(ltv)} is within the typical ${fmtPct(maxLTV)} ceiling for this asset type and purpose.` });
      }
    }

    // DSCR
    if (purpRule.mode === 'construction') {
      flags.push({ key: 'dscr', severity: 'info', title: 'DSCR evaluated at stabilization',
        detail: 'Construction loans are underwritten on cost and as-complete value, not in-place DSCR. We\'ll need a stabilized pro forma once plans are finalized.' });
    } else if (dscr === null) {
      flags.push({ key: 'dscr', severity: 'info', title: 'DSCR not yet calculable',
        detail: 'Add an annual NOI figure to estimate debt service coverage.' });
    } else if (dscr < 1.0) {
      flags.push({ key: 'dscr', severity: 'red', title: 'Property does not cover its own debt service',
        detail: `Estimated DSCR of ${dscr.toFixed(2)}x is below 1.00x — the property's income does not cover the requested debt service at ${rate.toFixed(2)}% / ${amort}yr.` });
    } else if (dscr < propRule.minDSCR) {
      flags.push({ key: 'dscr', severity: 'yellow', title: 'Coverage below typical minimum',
        detail: `Estimated DSCR of ${dscr.toFixed(2)}x is under the typical ${propRule.minDSCR.toFixed(2)}x minimum for ${propRule.label.toLowerCase()} — a smaller loan amount or interest-only period may bridge the gap.` });
    } else {
      flags.push({ key: 'dscr', severity: 'green', title: 'Coverage meets typical minimum',
        detail: `Estimated DSCR of ${dscr.toFixed(2)}x meets the typical ${propRule.minDSCR.toFixed(2)}x minimum for this asset type.` });
    }

    // Occupancy
    if (purpRule.mode !== 'construction' && inputs.occupancy !== null) {
      if (inputs.occupancy < 70) {
        flags.push({ key: 'occupancy', severity: 'red', title: 'Below stabilized occupancy',
          detail: `${inputs.occupancy}% physical occupancy is well under stabilization — expect a bridge or value-add structure rather than permanent financing until leased up.` });
      } else if (inputs.occupancy < 85) {
        flags.push({ key: 'occupancy', severity: 'yellow', title: 'Approaching stabilization',
          detail: `${inputs.occupancy}% physical occupancy is below the typical 85–90% stabilization threshold most permanent lenders want to see.` });
      } else {
        flags.push({ key: 'occupancy', severity: 'green', title: 'Occupancy supports permanent financing',
          detail: `${inputs.occupancy}% physical occupancy is at or above typical stabilization thresholds.` });
      }
    }

    // Credit
    if (inputs.credit >= 700) {
      flags.push({ key: 'credit', severity: 'green', title: 'Strong credit profile',
        detail: `Estimated score of ${inputs.credit}+ opens the full conventional and agency lender pool.` });
    } else if (inputs.credit >= 660) {
      flags.push({ key: 'credit', severity: 'yellow', title: 'Credit may limit pricing/lender pool',
        detail: `Estimated score in the ${inputs.credit}–699 range is workable but may narrow lender options and pricing versus a 700+ profile.` });
    } else {
      flags.push({ key: 'credit', severity: 'red', title: 'Credit likely limits conventional options',
        detail: `Estimated score under 660 significantly narrows the conventional lender pool — bridge, private or portfolio financing is the more likely path.` });
    }

    // Experience
    const loanSize = loanAmount || 0;
    if (inputs.experience === 0) {
      if (loanSize > 3000000) {
        flags.push({ key: 'experience', severity: 'red', title: 'First deal at this loan size',
          detail: 'A first commercial deal at this loan size typically requires an experienced co-sponsor, key principal, or third-party property manager to satisfy lender guidelines.' });
      } else if (loanSize > 1000000) {
        flags.push({ key: 'experience', severity: 'yellow', title: 'First commercial deal',
          detail: 'Lenders will want to see a strong business plan and, ideally, an experienced partner or property manager involved.' });
      } else {
        flags.push({ key: 'experience', severity: 'green', title: 'First deal, manageable size',
          detail: 'Loan size is modest enough that limited experience is unlikely to be a primary obstacle.' });
      }
    } else if (inputs.experience === 2 && loanSize > 6000000) {
      flags.push({ key: 'experience', severity: 'yellow', title: 'Loan size large relative to experience',
        detail: '1–3 years of CRE experience against a loan of this size may draw extra lender scrutiny — a resume and track record summary will help.' });
    } else {
      flags.push({ key: 'experience', severity: 'green', title: 'Experience supports this loan size',
        detail: 'Reported experience is in line with what lenders typically expect for a deal of this size.' });
    }

    // Liquidity / reserves
    if (inputs.liquidity === null) {
      flags.push({ key: 'liquidity', severity: 'info', title: 'Liquidity not yet entered',
        detail: 'Add liquid assets/reserves to check against estimated cash-to-close plus a 6-month reserve requirement.' });
    } else if (liquidityShortfall > 0) {
      flags.push({ key: 'liquidity', severity: 'red', title: 'Estimated liquidity shortfall',
        detail: `Estimated cash needed (equity/costs + 6 months reserves) is ${fmtMoney(totalCashNeeded)} against ${fmtMoney(inputs.liquidity)} reported — a shortfall of roughly ${fmtMoney(liquidityShortfall)}.` });
    } else if (inputs.liquidity - totalCashNeeded < reserveRequirement) {
      flags.push({ key: 'liquidity', severity: 'yellow', title: 'Reserves adequate but thin',
        detail: `Liquidity covers the estimated ${fmtMoney(totalCashNeeded)} requirement, but the post-closing cushion is thin. A bit more reserve strength will help underwriting.` });
    } else {
      flags.push({ key: 'liquidity', severity: 'green', title: 'Strong liquidity position',
        detail: `Reported liquidity of ${fmtMoney(inputs.liquidity)} comfortably covers the estimated ${fmtMoney(totalCashNeeded)} cash-to-close plus reserves.` });
    }

    // Bankruptcy / foreclosure
    if (inputs.bkHistory === 'yes') {
      flags.push({ key: 'bk', severity: 'red', title: 'Credit event within 7 years',
        detail: 'A bankruptcy, foreclosure or short sale within the last 7 years requires a seasoning review and a signed letter of explanation, and will narrow the lender pool.' });
    } else {
      flags.push({ key: 'bk', severity: 'green', title: 'No credit event disclosed', detail: 'No bankruptcy, foreclosure or short sale reported in the last 7 years.' });
    }

    // Determination
    const score = flags.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
    let determination;
    if (score <= 1) {
      determination = { level: 'strong', label: 'Strong Fit — Ready to Package', sub: 'This scenario is well within typical guidelines. Send over the documents below and we can move quickly.' };
    } else if (score <= 4) {
      determination = { level: 'workable', label: 'Workable — Conditions Apply', sub: 'This deal has a path forward, but one or more items below will need to be addressed or structured around before we submit.' };
    } else if (score <= 8) {
      determination = { level: 'structuring', label: 'Needs Structuring Before Submission', sub: 'Several items below will meaningfully affect terms or lender fit. Let\'s talk through structure before this goes to a lender.' };
    } else {
      determination = { level: 'nonstarter', label: 'Not Fundable As Presented', sub: 'As entered, this scenario has multiple hard obstacles for conventional commercial financing. Call your loan officer directly — there may still be a non-conventional path.' };
    }

    const metrics = {
      propRule, purpRule, ltv, maxLTV, dscr, minDSCR: propRule.minDSCR,
      monthlyDebtService, annualDebtService, equityRequired, reserveRequirement,
      totalCashNeeded, liquidityShortfall, rate, amort
    };

    return { metrics, flags, determination, score };
  }

  // ── Document checklist ──────────────────────────────────────────
  function buildChecklist(inputs, result) {
    const purpRule = result.metrics.purpRule;
    const groups = {};
    const add = (group, items) => {
      groups[group] = (groups[group] || []).concat(items);
    };

    add('Borrower Financials', [
      'Signed Personal Financial Statement (PFS) — each guarantor with 20%+ ownership',
      'Last 2 years personal tax returns — all guarantors',
      'Last 2 years business tax returns — operating entity',
      'Last 3 months business bank statements',
      'Schedule of Real Estate Owned (SREO)'
    ]);

    add('Entity & Identification', [
      'Entity documents — Articles of Organization/Incorporation, Operating Agreement/Bylaws',
      'EIN letter (IRS CP 575 or 147C)',
      'Certificate of good standing (current entity filing)',
      'Government-issued photo ID for all guarantors'
    ]);

    add('Property Documents', [
      'Current property tax bill',
      'Insurance declarations page or quote',
      'Recent photos of the property (interior & exterior)'
    ]);

    if (purpRule.mode !== 'construction') {
      add('Property Documents', [
        'Trailing 12-month operating statement / P&L',
        'Current rent roll with lease terms',
        'Copies of signed leases for major tenants'
      ]);
    }

    if (inputs.loanPurpose === 'purchase') {
      add('Deal-Specific', ['Fully executed purchase agreement', 'Earnest money deposit confirmation']);
    }
    if (inputs.loanPurpose === 'ratetermrefi' || inputs.loanPurpose === 'cashoutrefi') {
      add('Deal-Specific', ['Current mortgage statement', 'Payoff demand letter (if available)']);
    }
    if (purpRule.mode === 'construction') {
      add('Deal-Specific', [
        'Construction budget & sources/uses',
        'Full plans & specifications',
        'General contractor license & builder\'s risk insurance quote',
        'Executed GC agreement (AIA or equivalent)',
        'Zoning verification / entitlements'
      ]);
    }
    if (purpRule.mode === 'bridge') {
      add('Deal-Specific', ['Written exit strategy (refinance or sale timeline)']);
    }
    if (purpRule.mode === 'sba') {
      add('Deal-Specific', [
        'SBA Form 1919 — Borrower Information Form',
        'SBA Form 413 — Personal Financial Statement',
        'Personal resume for each principal',
        'Business debt schedule',
        'Last 3 years business financial statements',
        'Business plan (start-up or acquisition)'
      ]);
    }

    const typeExtras = {
      hotel: ['Franchise agreement (if flagged)', 'Trailing 3-year STAR/CBRE reports', 'FF&E reserve schedule'],
      special: ['Phase I Environmental Site Assessment'],
      mhp: ['Park rules & regulations', 'Utility billing structure (master-metered vs. direct)'],
      medical: ['Tenant/physician group lease and credit summary'],
      selfstorage: ['Unit mix & rate schedule', 'Trailing 12-month occupancy history']
    };
    if (typeExtras[inputs.propertyType]) {
      add('Deal-Specific', typeExtras[inputs.propertyType]);
    }

    const conditional = [];
    if (inputs.bkHistory === 'yes') {
      conditional.push('Signed letter of explanation for bankruptcy/foreclosure/short sale, with supporting documentation');
    }
    if (inputs.occupancy !== null && inputs.occupancy < 85 && purpRule.mode !== 'construction') {
      conditional.push('Lease-up / marketing plan with supporting rent comps');
    }
    if (inputs.experience === 0 && inputs.loanAmount > 1000000) {
      conditional.push('Resume/bio for key principal(s) or proposed third-party property manager');
    }
    if (result.metrics.dscr !== null && result.metrics.dscr < result.metrics.minDSCR) {
      conditional.push('Updated pro forma showing path to required debt service coverage');
    }
    if (conditional.length) {
      add('Additional Items Based on Your Scenario', conditional);
    }

    return groups;
  }

  // ── Fallback narrative (used if the AI endpoint is unavailable) ─
  function buildFallbackNarrative(inputs, result) {
    const reds = result.flags.filter(f => f.severity === 'red');
    const yellows = result.flags.filter(f => f.severity === 'yellow');
    const propLabel = result.metrics.propRule.label.toLowerCase();
    const purpLabel = result.metrics.purpRule.label.toLowerCase();

    let out = `This is a ${propLabel} ${purpLabel} scenario. `;
    if (reds.length === 0 && yellows.length === 0) {
      out += 'On the numbers you provided, this scenario lines up well with typical commercial lending guidelines across leverage, coverage, credit and liquidity. Send over the document checklist below and we can move toward term sheets.';
    } else if (reds.length === 0) {
      out += `The core numbers work, but a few items — ${yellows.map(f => f.title.toLowerCase()).join(', ')} — will shape which lenders fit best and what conditions come back. Nothing here looks disqualifying.`;
    } else {
      out += `As entered, ${reds.map(f => f.title.toLowerCase()).join(' and ')} will need to be addressed before this is ready for a conventional lender. That doesn't mean it's dead — it usually means a different structure (bridge, seller financing, a stronger co-sponsor, or a smaller ask) gets it done. Worth a direct conversation before we package anything.`;
    }
    return out;
  }

  async function fetchNarrative(inputs, result) {
    try {
      const res = await fetch('/.netlify/functions/scenario-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs,
          metrics: {
            ltv: result.metrics.ltv, maxLTV: result.metrics.maxLTV,
            dscr: result.metrics.dscr, minDSCR: result.metrics.minDSCR,
            equityRequired: result.metrics.equityRequired,
            reserveRequirement: result.metrics.reserveRequirement,
            liquidityShortfall: result.metrics.liquidityShortfall
          },
          flags: result.flags.map(f => ({ title: f.title, severity: f.severity })),
          determination: result.determination.label
        })
      });
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      if (!data.narrative) throw new Error('empty');
      return data.narrative;
    } catch {
      return buildFallbackNarrative(inputs, result);
    }
  }

  // ── Rendering ────────────────────────────────────────────────
  let lastResult = null;
  let lastInputs = null;
  let lastChecklist = null;

  function renderDeterminationBanner(determination) {
    banner.className = 'determination-banner det-' + determination.level;
    if (bannerIcon) bannerIcon.textContent = DETERMINATION_ICON[determination.level] || '';
    bannerLabel.textContent = determination.label;
    bannerSub.textContent = determination.sub;
  }

  function gaugeClass(severity) {
    if (severity === 'green' || severity === 'yellow' || severity === 'red') return 'gauge-' + severity;
    return 'gauge-info';
  }

  function renderMetrics(metrics, inputs, flags) {
    const ltvFlag  = flags.find(f => f.key === 'ltv');
    const dscrFlag = flags.find(f => f.key === 'dscr');
    const ltvGaugePct  = metrics.ltv !== null ? Math.min(100, Math.round((metrics.ltv / (metrics.maxLTV * 1.3)) * 100)) : 0;
    const dscrGaugePct = metrics.dscr !== null ? Math.min(100, Math.round((metrics.dscr / (metrics.minDSCR * 1.5)) * 100)) : 0;

    const rows = [
      { label: 'Loan-to-Value', value: metrics.ltv !== null ? fmtPct(metrics.ltv) : '—', note: `Typical ceiling ~${fmtPct(metrics.maxLTV)}`,
        gauge: metrics.ltv !== null ? { pct: ltvGaugePct, cls: gaugeClass(ltvFlag && ltvFlag.severity) } : null },
      { label: 'DSCR', value: metrics.dscr !== null ? metrics.dscr.toFixed(2) + 'x' : '—', note: `Typical minimum ${metrics.minDSCR.toFixed(2)}x`,
        gauge: metrics.dscr !== null ? { pct: dscrGaugePct, cls: gaugeClass(dscrFlag && dscrFlag.severity) } : null },
      { label: 'Est. Monthly Debt Service', value: fmtMoney(metrics.monthlyDebtService), note: `${metrics.rate.toFixed(2)}% / ${metrics.amort}yr amortization`, gauge: null },
      { label: 'Est. Cash to Close', value: fmtMoney(metrics.equityRequired), note: 'Equity + est. 3% closing costs', gauge: null },
      { label: '6-Month Reserve Requirement', value: fmtMoney(metrics.reserveRequirement), note: 'Typical post-closing minimum', gauge: null },
      { label: 'Total Est. Cash Needed', value: fmtMoney(metrics.totalCashNeeded), note: inputs.liquidity !== null ? `vs. ${fmtMoney(inputs.liquidity)} reported liquidity` : 'Liquidity not entered', gauge: null }
    ];
    metricsGrid.innerHTML = rows.map(r => `
      <div class="metric-card">
        <div class="metric-label">${r.label}</div>
        <div class="metric-value">${r.value}</div>
        <div class="metric-note">${r.note}</div>
        ${r.gauge ? `<div class="metric-gauge"><div class="metric-gauge-fill ${r.gauge.cls}" style="--gauge-w:${r.gauge.pct}%"></div></div>` : ''}
      </div>`).join('');
  }

  function renderFlags(flags) {
    flagsList.innerHTML = flags.map((f, i) => `
      <li class="flag-item flag-${f.severity}" style="--i:${i}">
        <span class="flag-icon" aria-hidden="true">${SEVERITY_ICON[f.severity]}</span>
        <span class="flag-body">
          <span class="flag-title">${f.title}</span>
          <span class="flag-detail">${f.detail}</span>
        </span>
      </li>`).join('');
  }

  function updateChecklistProgress() {
    if (!checklistProgress) return;
    const boxes = checklistGroups.querySelectorAll('input[type="checkbox"]');
    const total = boxes.length;
    const checked = checklistGroups.querySelectorAll('input[type="checkbox"]:checked').length;
    checklistProgressFill.style.width = total ? Math.round((checked / total) * 100) + '%' : '0%';
    checklistProgressLabel.textContent = `${checked} of ${total} collected`;
    checklistGroups.querySelectorAll('.checklist-group').forEach(group => {
      const countEl = group.querySelector('[data-group-count]');
      if (!countEl) return;
      const groupBoxes = group.querySelectorAll('input[type="checkbox"]');
      const groupChecked = group.querySelectorAll('input[type="checkbox"]:checked').length;
      countEl.textContent = `${groupChecked}/${groupBoxes.length}`;
    });
  }

  function renderChecklist(groups) {
    const order = ['Borrower Financials', 'Entity & Identification', 'Property Documents', 'Deal-Specific', 'Additional Items Based on Your Scenario'];
    checklistGroups.innerHTML = order
      .filter(g => groups[g] && groups[g].length)
      .map(g => `
        <div class="checklist-group">
          <h4>${g} <span class="checklist-group-count" data-group-count>0/${groups[g].length}</span></h4>
          <ul>${groups[g].map((item, i) => `
            <li><label class="checklist-item">
              <input type="checkbox" id="ck-${g.replace(/\s+/g, '')}-${i}">
              <span>${item}</span>
            </label></li>`).join('')}</ul>
        </div>`).join('');
    updateChecklistProgress();
  }

  if (checklistGroups) {
    checklistGroups.addEventListener('change', (e) => {
      if (e.target && e.target.matches('input[type="checkbox"]')) updateChecklistProgress();
    });
  }

  function getInputs() {
    const val = (id) => document.getElementById(id).value;
    const num = (id) => {
      const v = val(id);
      return v === '' ? null : parseFloat(v);
    };
    return {
      propertyType: val('sd-type'),
      loanPurpose: val('sd-purpose'),
      price: num('sd-price') || 0,
      loanAmount: num('sd-loan') || 0,
      noi: num('sd-noi'),
      occupancy: num('sd-occupancy'),
      rate: num('sd-rate'),
      amort: parseInt(val('sd-amort'), 10),
      brokerFeePct: num('sd-brokerfee'),
      experience: parseInt(val('sd-exp'), 10),
      credit: parseInt(val('sd-credit'), 10),
      liquidity: num('sd-liquidity'),
      entity: val('sd-entity'),
      bkHistory: val('sd-bk'),
      notes: val('sd-notes')
    };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }

    const inputs = getInputs();
    const result = evaluate(inputs);
    const checklist = buildChecklist(inputs, result);

    lastInputs = inputs;
    lastResult = result;
    lastChecklist = checklist;

    renderDeterminationBanner(result.determination);
    renderMetrics(result.metrics, inputs, result.flags);
    renderFlags(result.flags);
    renderChecklist(checklist);

    narrativeText.textContent = 'Generating a written assessment…';
    resultsSection.hidden = false;
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const narrative = await fetchNarrative(inputs, result);
    narrativeText.textContent = narrative;
    lastResult.narrative = narrative;
  });

  resetBtn.addEventListener('click', () => {
    form.reset();
    resultsSection.hidden = true;
    document.getElementById('scenario-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ── PDF export ──────────────────────────────────────────────
  let logoDataUrl = null;
  async function loadLogo() {
    if (logoDataUrl) return logoDataUrl;
    try {
      const res = await fetch('/assets/element-commercial-logo.png');
      const blob = await res.blob();
      logoDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      logoDataUrl = null; // PDF still generates fine without the logo
    }
    return logoDataUrl;
  }

  downloadBtn.addEventListener('click', async () => {
    if (!lastResult) return;
    downloadBtn.disabled = true;
    try {
      await generatePdf(lastInputs, lastResult, lastChecklist);
    } finally {
      downloadBtn.disabled = false;
    }
  });

  async function generatePdf(inputs, result, checklist) {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) {
      alert('PDF library failed to load — check your connection and try again.');
      return;
    }
    const logo = await loadLogo();
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 48;
    let y = 56;

    const INK = [20, 18, 14];
    const GOLD = [188, 157, 98];
    const GOLD_DEEP = [140, 112, 62];
    const MID = [107, 100, 90];
    const CREAM = [250, 247, 240];
    // Status tones for flags/determination — kept semantic (not gold) so
    // risk signal stays legible; gold is reserved for brand/chrome elements.
    const STATUS = { good: [46, 107, 74], caution: [201, 122, 27], bad: [176, 53, 33], badDeep: [122, 36, 22] };
    const SEV_COLOR = { green: STATUS.good, yellow: STATUS.caution, red: STATUS.bad, info: MID };

    const checkBreak = (needed) => {
      if (y + needed > doc.internal.pageSize.getHeight() - 56) {
        doc.addPage();
        y = 56;
      }
    };

    // Header — logo + letterhead-style rule
    const logoSize = 44;
    if (logo) {
      try { doc.addImage(logo, 'PNG', margin, y - 30, logoSize, logoSize); } catch { /* skip logo if malformed */ }
    }
    const headerTextX = logo ? margin + logoSize + 14 : margin;
    doc.setFont('times', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...INK);
    doc.text('ELEMENT COMMERCIAL', headerTextX, y - 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...GOLD_DEEP);
    doc.text('SCENARIO DESK', headerTextX, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MID);
    doc.text(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), pageWidth - margin, y - 12, { align: 'right' });
    y += 22;
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(1.25);
    doc.line(margin, y, pageWidth - margin, y);
    doc.setDrawColor(...MID);
    doc.setLineWidth(0.4);
    doc.line(margin, y + 2.5, pageWidth - margin, y + 2.5);
    y += 34;

    doc.setFont('times', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(...INK);
    doc.text('Scenario Summary & Preliminary Conditions', margin, y);
    y += 18;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...MID);
    doc.text('Equal Housing Lender', margin, y);
    y += 30;

    // Determination banner
    const det = result.determination;
    const DET_FILL = { strong: STATUS.good, workable: STATUS.caution, structuring: STATUS.bad, nonstarter: STATUS.badDeep };
    doc.setFillColor(...(DET_FILL[det.level] || STATUS.bad));
    doc.roundedRect(margin, y, pageWidth - margin * 2, 46, 4, 4, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(det.label, margin + 14, y + 19);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const subLines = doc.splitTextToSize(det.sub, pageWidth - margin * 2 - 28);
    doc.text(subLines, margin + 14, y + 33);
    y += 46 + 24;

    // Scenario snapshot
    doc.setTextColor(...INK);
    doc.setFont('times', 'bold');
    doc.setFontSize(13);
    doc.text('Scenario Snapshot', margin, y);
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.75);
    doc.line(margin, y + 5, margin + 34, y + 5);
    y += 20;

    const snapshotRows = [
      ['Property Type', result.metrics.propRule.label],
      ['Loan Purpose', result.metrics.purpRule.label],
      ['Purchase Price / Value', fmtMoney(inputs.price)],
      ['Loan Amount Requested', fmtMoney(inputs.loanAmount)],
      ['Loan-to-Value', result.metrics.ltv !== null ? fmtPct(result.metrics.ltv) + ` (typical ceiling ~${fmtPct(result.metrics.maxLTV)})` : '—'],
      ['DSCR', result.metrics.dscr !== null ? result.metrics.dscr.toFixed(2) + 'x' + ` (typical min ${result.metrics.minDSCR.toFixed(2)}x)` : 'Not calculable from inputs'],
      ['Est. Rate / Amortization', `${result.metrics.rate.toFixed(2)}% / ${result.metrics.amort} yr`],
      ['Est. Monthly Debt Service', fmtMoney(result.metrics.monthlyDebtService)],
      ['Est. Cash to Close', fmtMoney(result.metrics.equityRequired)],
      ['6-Month Reserve Requirement', fmtMoney(result.metrics.reserveRequirement)],
      ['Reported Liquidity', inputs.liquidity !== null ? fmtMoney(inputs.liquidity) : 'Not provided']
    ];
    if (inputs.brokerFeePct !== null) {
      const brokerFeeAmount = inputs.loanAmount * (inputs.brokerFeePct / 100);
      snapshotRows.push(['Broker Fee', `${fmtMoney(brokerFeeAmount)} (${inputs.brokerFeePct.toFixed(2)}% of loan amount)`]);
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    snapshotRows.forEach(([label, value], i) => {
      checkBreak(18);
      if (i % 2 === 0) {
        doc.setFillColor(...CREAM);
        doc.rect(margin, y - 10, pageWidth - margin * 2, 16, 'F');
      }
      doc.setTextColor(...MID);
      doc.text(label, margin + 6, y);
      doc.setTextColor(...INK);
      doc.text(String(value), margin + 220, y);
      y += 16;
    });
    y += 20;

    // Flags
    checkBreak(30);
    doc.setFont('times', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...INK);
    doc.text('Flags & Considerations', margin, y);
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.75);
    doc.line(margin, y + 5, margin + 34, y + 5);
    y += 20;
    doc.setFontSize(9.5);
    result.flags.forEach(f => {
      const detailLines = doc.splitTextToSize(f.detail, pageWidth - margin * 2 - 18);
      checkBreak(14 + detailLines.length * 12 + 6);
      doc.setFillColor(...(SEV_COLOR[f.severity] || MID));
      doc.circle(margin + 3.5, y - 3, 3.5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...(SEV_COLOR[f.severity] || MID));
      doc.text(f.title, margin + 14, y);
      y += 13;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...MID);
      doc.text(detailLines, margin + 14, y);
      y += detailLines.length * 12 + 6;
    });
    y += 10;

    // Narrative
    if (result.narrative) {
      checkBreak(50);
      doc.setFont('times', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(...INK);
      doc.text("Our Take", margin, y);
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(0.75);
      doc.line(margin, y + 5, margin + 34, y + 5);
      y += 20;
      doc.setFont('times', 'italic');
      doc.setFontSize(10.5);
      doc.setTextColor(...INK);
      const narrLines = doc.splitTextToSize(result.narrative, pageWidth - margin * 2);
      checkBreak(narrLines.length * 13);
      doc.text(narrLines, margin, y);
      y += narrLines.length * 13 + 22;
    }

    // Checklist
    checkBreak(30);
    doc.setFont('times', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...INK);
    doc.text('Documents We\'ll Need From You', margin, y);
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.75);
    doc.line(margin, y + 5, margin + 34, y + 5);
    y += 24;

    const order = ['Borrower Financials', 'Entity & Identification', 'Property Documents', 'Deal-Specific', 'Additional Items Based on Your Scenario'];
    order.filter(g => checklist[g] && checklist[g].length).forEach(group => {
      checkBreak(18);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...GOLD_DEEP);
      doc.text(group.toUpperCase(), margin, y);
      y += 14;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(...INK);
      checklist[group].forEach(item => {
        const lines = doc.splitTextToSize(item, pageWidth - margin * 2 - 22);
        checkBreak(lines.length * 12 + 4);
        doc.setDrawColor(...GOLD_DEEP);
        doc.setLineWidth(0.75);
        doc.rect(margin + 6, y - 8, 8, 8, 'S');
        doc.text(lines, margin + 22, y);
        y += lines.length * 12 + 4;
      });
      y += 8;
    });

    // Disclaimer footer on last page
    checkBreak(70);
    y += 10;
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.75);
    doc.line(margin, y, pageWidth - margin, y);
    y += 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...MID);
    const disclaimer = 'This document is a preliminary, automated summary based solely on information self-reported by the borrower and has not been independently verified. It is not a pre-qualification, pre-approval, term sheet, commitment to lend, or offer of credit, and does not constitute underwriting. Actual terms and conditions depend on full underwriting, appraisal, third-party reports and applicable lender guidelines, and are subject to change. Equal Housing Lender.';
    doc.text(doc.splitTextToSize(disclaimer, pageWidth - margin * 2), margin, y);

    const fileSafeType = (result.metrics.propRule.label || 'Deal').replace(/[^\w]+/g, '-');
    doc.save(`Scenario-Summary-${fileSafeType}-${Date.now()}.pdf`);
  }

})();
