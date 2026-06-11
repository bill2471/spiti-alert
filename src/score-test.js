// Δοκιμή βαθμολόγησης σε αποθηκευμένο JSON αγγελιών (χωρίς scraping/email).
// Χρήση: node src/score-test.js <αρχείο.json>

const fs = require('fs');
const { matchListing, scoreListing } = require('./index');

const file = process.argv[2];
if (!file) { console.error('Δώσε αρχείο JSON με αγγελίες'); process.exit(1); }

const raw = fs.readFileSync(file, 'utf8');
const items = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
if (!Array.isArray(items)) { console.error('Το αρχείο δεν περιέχει πίνακα αγγελιών'); process.exit(1); }

const rows = [];
let rejected = 0;
for (const item of items) {
  const match = matchListing(item);
  if (!match) { rejected++; continue; }
  const scored = scoreListing(item, match);
  rows.push({ item, match, scored });
}
rows.sort((a, b) => b.scored.score - a.scored.score);

console.log(`Σύνολο: ${items.length} · Κομμένες από σκληρά φίλτρα: ${rejected} · Βαθμολογημένες: ${rows.length}\n`);
for (const r of rows) {
  console.log(`[${String(r.scored.score).padStart(3)}/100] €${r.item.price} · ${r.item.sq_meters} τ.μ. · ${r.match.zone}${r.match.noCoords ? ' (χωρίς συντ/νες)' : ''}`);
  if (r.scored.why.length) console.log(`          + ${r.scored.why.join(' · ')}`);
  if (r.scored.missing.length) console.log(`          − λείπει: ${r.scored.missing.join(' · ')}`);
  console.log(`          ${r.item.url}\n`);
}
