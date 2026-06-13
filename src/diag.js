// Διαγνωστικό: τρέχει τον actor μία φορά και δείχνει ΟΛΟ το «χωνί» —
// τι κόβεται και ΓΙΑΤΙ, τι περνά, με σκορ και αν έχει ήδη σταλεί.
const fs = require('fs');
const path = require('path');
const cfg = require('../config.json');
const { scoreListing, haversineKm } = require('./index');

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ACTOR = 'fayoussef~spitogatos-scraper';
const isYes = (v) => v === '1' || v === 'yes' || v === 1 || v === true;
const seen = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'seen.json'), 'utf8'));

function zoneOf(item) {
  const lat = Number(item.latitude), lon = Number(item.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0) {
    for (const z of cfg.redZones) if (haversineKm(lat, lon, z.lat, z.lon) <= z.radiusKm) return { red: z.name };
    for (const z of cfg.greenZones) if (haversineKm(lat, lon, z.lat, z.lon) <= z.radiusKm) return { green: z.name };
    return { outside: true };
  }
  const name = `${item.geographiesByLevel_4_fullName || ''} ${item.geographiesByLevel_2_fullName || ''}`;
  if (cfg.nameFallbackWhitelist.some((w) => name.includes(w))) return { green: item.geographiesByLevel_4_fullName || '(όνομα)' };
  return { nocoords: true };
}

function hardReason(item) {
  if (!item || !item.id || !item.url) return 'άκυρη εγγραφή';
  if (typeof item.price !== 'number' || item.price <= 0) return 'χωρίς τιμή';
  if (item.price > cfg.maxPrice) return `τιμή €${item.price} > €${cfg.maxPrice}`;
  if (typeof item.sq_meters !== 'number' || item.sq_meters < cfg.minSqMeters) return `${item.sq_meters} τ.μ. < ${cfg.minSqMeters}`;
  const yr = Number(item.year_of_construction) || 0;
  const renovYr = isYes(item.renovated) ? (Number(item.renovationYear) || 0) : 0;
  if (yr > 0 && yr < cfg.construction.minYear && renovYr < cfg.construction.renovationOverrideYear)
    return `κατασκευή ${yr} < ${cfg.construction.minYear} (χωρίς ανακαίνιση)`;
  if (isYes(item.requiresRenovation)) return 'χρήζει ανακαίνισης';
  if (isYes(item.unfinished)) return 'ημιτελές';
  const z = zoneOf(item);
  if (z.red) return `κόκκινη ζώνη: ${z.red}`;
  if (z.outside) return 'εκτός ζωνών (συντεταγμένες)';
  if (z.nocoords) return 'χωρίς συντεταγμένες & άγνωστη περιοχή';
  return null; // περνά
}

(async () => {
  const start = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ start_urls: cfg.startUrls.map((url) => ({ url })), max_pages: cfg.maxPages }),
  });
  const run = (await start.json()).data;
  let status = run.status, ds = run.defaultDatasetId;
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    await new Promise((r) => setTimeout(r, 8000));
    const d = (await (await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${APIFY_TOKEN}`)).json()).data;
    status = d.status; ds = d.defaultDatasetId;
  }
  const items = await (await fetch(`https://api.apify.com/v2/datasets/${ds}/items?token=${APIFY_TOKEN}&clean=true`)).json();
  fs.writeFileSync(path.join(__dirname, '..', 'diag-dump.json'), JSON.stringify(items, null, 1), 'utf8');

  const cut = {}, passing = [];
  for (const it of items) {
    const r = hardReason(it);
    if (r) { cut[r] = (cut[r] || 0) + 1; continue; }
    const z = zoneOf(it);
    const sc = scoreListing(it, { zone: z.green || '(?)', noCoords: !!z.nocoords });
    passing.push({ it, zone: z.green, sc });
  }
  passing.sort((a, b) => b.sc.score - a.sc.score);

  console.log(`\n===== ΑΚΤΙΝΟΓΡΑΦΙΑ — ${items.length} ενεργές αγγελίες ενοικίασης =====\n`);
  console.log(`ΚΟΜΜΕΝΕΣ από σκληρά φίλτρα (${items.length - passing.length}):`);
  for (const [reason, n] of Object.entries(cut).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(2)} × ${reason}`);
  console.log(`\nΠΕΡΝΟΥΝ ΤΑ ΦΙΛΤΡΑ (${passing.length}) — με σκορ & κατάσταση:`);
  for (const p of passing) {
    const sent = seen[p.it.id] ? '📨 ΣΤΑΛΘΗΚΕ' : (p.sc.score >= cfg.scoring.minScore ? '🆕 ΘΑ ΣΤΕΛΝΟΤΑΝ' : '🔇 σκορ<45 (σιωπή)');
    console.log(`   [${String(p.sc.score).padStart(3)}/100] €${p.it.price} · ${p.it.sq_meters}τμ · ${p.zone} · ${sent}`);
    console.log(`            ${p.it.url}`);
  }
  console.log('');
})().catch((e) => { console.error('ΣΦΑΛΜΑ:', e.message); process.exit(1); });
