// Χειροκίνητη αποστολή μίας αγγελίας από αποθηκευμένο δείγμα.
// Χρήση: node src/send-one.js <αρχείο.json> <listingId>

const fs = require('fs');
const path = require('path');
const { matchListing, scoreListing, sendEmail } = require('./index');

const [, , file, idArg] = process.argv;
if (!file || !idArg) { console.error('Χρήση: node src/send-one.js <αρχείο.json> <listingId>'); process.exit(1); }

const raw = fs.readFileSync(file, 'utf8');
const items = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
const item = items.find((x) => String(x.id) === String(idArg));
if (!item) { console.error(`Δεν βρέθηκε αγγελία με id ${idArg}`); process.exit(1); }

const match = matchListing(item);
if (!match) { console.error('Η αγγελία δεν περνά τα σκληρά φίλτρα — δεν στέλνεται.'); process.exit(1); }
const scored = scoreListing(item, match);

(async () => {
  const sent = await sendEmail([{ item, match, scored }]);
  if (sent) {
    // Σημείωσέ τη ως ιδωμένη για να μην ξανασταλεί από το cron
    const stateFile = path.join(__dirname, '..', 'state', 'seen.json');
    const seen = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    seen[item.id] = {
      firstSeen: new Date().toISOString().slice(0, 10),
      price: item.price,
      zone: match.zone,
      score: scored.score,
      url: item.url,
      sentManually: true,
    };
    fs.writeFileSync(stateFile, JSON.stringify(seen, null, 1), 'utf8');
    console.log(`Εστάλη [${scored.score}/100] και σημειώθηκε ως ιδωμένη: ${item.url}`);
  }
})().catch((e) => { console.error('ΣΦΑΛΜΑ:', e.message); process.exit(1); });
