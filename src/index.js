// spiti-alert — ειδοποιήσεις για νέες αγγελίες ενοικίασης από το Spitogatos
// Ροή: Apify scraper → σκληρά φίλτρα (τιμή, ελάχιστα τ.μ., γεω-ζώνες) →
//      βαθμολόγηση 0–100 (τ.μ., οικόπεδο, γκαράζ, τιμή, αποστάσεις, παροχές) →
//      dedupe → email μόνο για νέες αγγελίες με σκορ ≥ minScore.
// Μια αγγελία που της λείπει κάποια παροχή ΔΕΝ απορρίπτεται — χάνει πόντους
// και το email γράφει τι ακριβώς της λείπει.

const fs = require('fs');
const path = require('path');
const cfg = require('../config.json');

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const STATE_FILE = path.join(__dirname, '..', 'state', 'seen.json');
const ACTOR = 'fayoussef~spitogatos-scraper';

// Παραλήπτες: από το secret RECIPIENTS (comma-separated) ώστε να ΜΗΝ είναι στον
// δημόσιο κώδικα. Fallback στο config.recipients για τοπική δοκιμή.
const RECIPIENTS = (process.env.RECIPIENTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (RECIPIENTS.length) cfg.recipients = RECIPIENTS;

const isYes = (v) => v === '1' || v === 'yes' || v === 1 || v === true;

// Αντιστοιχίσεις κωδικών Spitogatos.
// ΕΝΕΡΓΕΙΑΚΗ: σειριακή 1→Α+ … 9→Η, 10→εξαιρείται/εκκρεμεί (υψηλή βεβαιότητα).
// ΘΕΡΜΑΝΣΗ: εμπειρική για τους κυρίαρχους κωδικούς — οι άγνωστοι εμφανίζονται ως «κωδ. Χ».
const ENERGY_CLASS = { 1: 'Α+', 2: 'Α', 3: 'Β+', 4: 'Β', 5: 'Γ', 6: 'Δ', 7: 'Ε', 8: 'Ζ', 9: 'Η', 10: '—' };
const HEATING_MEDIUM = { 1: 'Πετρέλαιο', 2: 'Φυσικό αέριο', 4: 'Ρεύμα', 5: 'Θερμοσυσσωρευτές', 6: 'Κλιματιστικό', 7: 'Σόμπα/ξύλα', 13: 'Αντλία θερμότητας' };
const HEATING_CONTROLLER = { 1: 'Αυτόνομη', 2: 'Κεντρική', 3: 'Χωρίς σύστημα', 4: 'Ατομική' };

function heatingLabel(item) {
  const ctrl = HEATING_CONTROLLER[item.heatingController];
  const med = HEATING_MEDIUM[item.heatingMedium] ||
    (item.heatingMedium != null ? `κωδ. ${item.heatingMedium}` : null);
  return [ctrl, med].filter(Boolean).join(' — ') || null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function runActor() {
  const input = {
    start_urls: cfg.startUrls.map((url) => ({ url })),
    max_pages: cfg.maxPages,
  };
  const start = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR}/runs?token=${APIFY_TOKEN}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }
  );
  if (!start.ok) throw new Error(`Apify start failed: ${start.status} ${await start.text()}`);
  const run = (await start.json()).data;
  console.log(`Apify run ${run.id} started…`);

  const deadline = Date.now() + 12 * 60 * 1000;
  let status = run.status, datasetId = run.defaultDatasetId;
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    if (Date.now() > deadline) throw new Error('Apify run timed out (12 min)');
    await new Promise((r) => setTimeout(r, 10000));
    const res = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${APIFY_TOKEN}`);
    const data = (await res.json()).data;
    status = data.status;
    datasetId = data.defaultDatasetId;
  }
  if (status !== 'SUCCEEDED') throw new Error(`Apify run ended with status ${status}`);

  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true`
  );
  if (!itemsRes.ok) throw new Error(`Dataset fetch failed: ${itemsRes.status}`);
  const items = await itemsRes.json();
  return Array.isArray(items) ? items : [];
}

// ΣΚΛΗΡΑ φίλτρα. Επιστρέφει {zone, noCoords} αν περνά, αλλιώς null.
function matchListing(item) {
  if (!item || !item.id || !item.url) return null;
  if (typeof item.price !== 'number' || item.price <= 0 || item.price > cfg.maxPrice) return null;
  if (typeof item.sq_meters !== 'number' || item.sq_meters < cfg.minSqMeters) return null;

  // Παλαιότητα (σκληρό όριο): κατασκευή ≥ minYear, ΕΚΤΟΣ αν ανακαινίστηκε ≥ renovationOverrideYear.
  // Άγνωστο έτος (0/κενό) ΔΕΝ κόβεται — περνά σημαδεμένο για έλεγχο στη βαθμολόγηση.
  const yr = Number(item.year_of_construction) || 0;
  const renovYr = isYes(item.renovated) ? (Number(item.renovationYear) || 0) : 0;
  if (yr > 0 && yr < cfg.construction.minYear && renovYr < cfg.construction.renovationOverrideYear) {
    return null;
  }

  // Χρήζει ανακαίνισης ή ημιτελές → εκτός (απόφαση Bill 2026-06-10)
  if (isYes(item.requiresRenovation) || isYes(item.unfinished)) return null;

  const lat = Number(item.latitude), lon = Number(item.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0) {
    for (const z of cfg.redZones) {
      if (haversineKm(lat, lon, z.lat, z.lon) <= z.radiusKm) return null;
    }
    for (const z of cfg.greenZones) {
      if (haversineKm(lat, lon, z.lat, z.lon) <= z.radiusKm) return { zone: z.name, noCoords: false };
    }
    return null;
  }
  // Χωρίς συντεταγμένες: δεκτό μόνο αν το όνομα περιοχής είναι στη λίστα, σημειωμένο για έλεγχο.
  const name = `${item.geographiesByLevel_4_fullName || ''} ${item.geographiesByLevel_2_fullName || ''}`;
  if (cfg.nameFallbackWhitelist.some((w) => name.includes(w))) {
    return { zone: item.geographiesByLevel_4_fullName || 'άγνωστη περιοχή', noCoords: true };
  }
  return null;
}

// ΒΑΘΜΟΛΟΓΗΣΗ 0–100: τίποτα δεν κόβεται, όλα μετράνε.
function scoreListing(item, match) {
  let pts = 0;
  const why = [];      // τι έδωσε πόντους
  const missing = [];  // τι λείπει σε σχέση με τις προτιμήσεις μας
  const flags = [];    // σημάνσεις για το email (χωρίς πόντους)

  // Υπνοδωμάτια (στόχος 3 — δύο γιοι + γονείς)
  const rooms = Number(item.rooms) || 0;
  if (rooms >= 4) { pts += 10; why.push(`${rooms} υ/δ +10`); }
  else if (rooms >= cfg.scoring.targetBedrooms) { pts += 8; why.push(`${rooms} υ/δ +8`); }
  else if (rooms > 0) missing.push(`μόνο ${rooms} υπνοδωμάτια (στόχος ${cfg.scoring.targetBedrooms})`);

  // Μπάνια / WC
  const baths = Number(item.no_of_bathrooms) || 0;
  const wc = Number(item.no_of_WC) || 0;
  if (baths >= 2) { pts += 5; why.push(`${baths} μπάνια +5`); }
  else if (baths >= 1 && wc >= 1) { pts += 3; why.push(`μπάνιο+WC +3`); }

  // Ενεργειακή κλάση (1=Α+ … 9=Η)
  const ec = Number(item.energyClass) || 0;
  let ecPts = 0;
  if (ec >= 1 && ec <= 2) ecPts = 6;
  else if (ec <= 4 && ec >= 3) ecPts = 4;
  else if (ec === 5) ecPts = 2;
  else if (ec === 8 || ec === 9) ecPts = -3;
  if (ecPts) {
    pts += ecPts;
    why.push(`ενεργειακή ${ENERGY_CLASS[ec]} ${ecPts > 0 ? '+' : ''}${ecPts}`);
  }

  // Θέρμανση: μέσο + έλεγχος + ενδοδαπέδια
  const hm = Number(item.heatingMedium) || 0;
  let hmPts = 0;
  if (hm === 2 || hm === 13) hmPts = 5;        // φυσικό αέριο / αντλία θερμότητας
  else if (hm === 1) hmPts = 3;                // πετρέλαιο
  else if (hm > 0) hmPts = 1;
  if (hmPts) { pts += hmPts; why.push(`θέρμανση ${HEATING_MEDIUM[hm] || 'κωδ. ' + hm} +${hmPts}`); }
  const hc = Number(item.heatingController) || 0;
  if (hc === 1 || hc === 4) pts += 2;          // αυτόνομη / ατομική
  else if (hc === 3) { pts -= 2; missing.push('χωρίς σύστημα θέρμανσης'); }
  if (isYes(item.heatingUnderFloor)) { pts += 4; why.push('ενδοδαπέδια +4'); }

  // Φόρτιση EV (έχουμε 2 ηλεκτρικά!)
  if (isYes(item.electricCarChargingFacilities)) {
    pts += 8; why.push('φόρτιση EV +8'); flags.push('🔌 Υποδομή φόρτισης ηλεκτρικού αυτοκινήτου!');
  }

  // Κουφώματα / ασφάλεια / λοιπά
  if (item.glassType === 'Triple') { pts += 3; why.push('τριπλά τζάμια +3'); }
  else if (item.glassType === 'Double') pts += 2;
  if (isYes(item.secure_door)) pts += 1;
  if (isYes(item.alarm)) pts += 1;
  if (Number(item.commonExpenses) === 0 && item.commonExpenses != null) pts += 2;
  if (isYes(item.view)) pts += 1;
  if (Number(item.balconyArea) >= 20) pts += 2;
  if (isYes(item.luxHome)) pts += 2;

  // Τιμή: σημάνσεις χωρίς πόντους
  if (isYes(item.negotiablePrice)) flags.push('💬 Συζητήσιμη τιμή');
  if (isYes(item.priceIncludesPower) || isYes(item.priceIncludesWater) ||
      isYes(item.priceIncludesInternet) || isYes(item.priceIncludesSharedExp)) {
    pts += 3;
    flags.push('💡 Η τιμή περιλαμβάνει λογαριασμούς/κοινόχρηστα');
  }
  if (item.firstPublishDate) {
    const days = Math.round((Date.now() - new Date(item.firstPublishDate).getTime()) / 86400000);
    if (days > 60) flags.push(`⏳ ~${days} μέρες στην αγορά — πιθανό περιθώριο διαπραγμάτευσης`);
  }

  // Τετραγωνικά (στόχος cfg.scoring.targetSqMeters, σήμερα μένουν σε 200 τ.μ.)
  const s = item.sq_meters || 0;
  let sqmPts = 0;
  if (s >= 180) sqmPts = 20;
  else if (s >= 150) sqmPts = 15;
  else if (s >= cfg.scoring.targetSqMeters) sqmPts = 10;
  else missing.push(`κάτω από τον στόχο των ${cfg.scoring.targetSqMeters} τ.μ.`);
  if (sqmPts) { pts += sqmPts; why.push(`${s} τ.μ. +${sqmPts}`); }

  // Οικόπεδο / αυλή (σήμερα έχουν 2 στρέμματα — μετράει πολύ)
  const lot = Number(item.lotSize) || 0;
  let lotPts = 0;
  if (lot >= 2000) lotPts = 18;
  else if (lot >= 1000) lotPts = 15;
  else if (lot >= 300) lotPts = 10;
  else if (lot > 0) lotPts = 5;
  else missing.push('χωρίς αναφερόμενο οικόπεδο/αυλή');
  if (lotPts) { pts += lotPts; why.push(`οικόπεδο ${lot} τ.μ. +${lotPts}`); }

  // Γκαράζ / πάρκινγκ (ισχυρή προτίμηση — και για τον φορτιστή EV)
  if (item.garage === 'yes' || item.garage === '1') { pts += 12; why.push('γκαράζ +12'); }
  else missing.push('γκαράζ (ίσως υπάρχει χώρος στην αυλή — δες φωτό)');

  // Τιμή: όσο πιο κάτω από το ταβάνι, τόσο καλύτερα (€450− → +15, €900 → +0)
  const pricePts = Math.max(0, Math.min(15, Math.round((cfg.maxPrice - item.price) / 30)));
  if (pricePts) { pts += pricePts; why.push(`τιμή €${item.price} +${pricePts}`); }

  // Αποστάσεις (μόνο αν έχουμε συντεταγμένες)
  if (!match.noCoords) {
    const { work, school } = cfg.referencePoints;
    const dW = haversineKm(item.latitude, item.longitude, work.lat, work.lon);
    const wPts = dW <= 10 ? 10 : dW <= 15 ? 7 : dW <= 20 ? 5 : dW <= 25 ? 3 : 1;
    pts += wPts; why.push(`δουλειά ${dW.toFixed(0)} χλμ +${wPts}`);
    const dS = haversineKm(item.latitude, item.longitude, school.lat, school.lon);
    const sPts = dS <= 10 ? 5 : dS <= 15 ? 3 : 1;
    pts += sPts;
  }

  // Παροχές
  if (isYes(item.garden)) { pts += 5; why.push('κήπος +5'); }
  if (isYes(item.fireplace)) { pts += 4; why.push('τζάκι +4'); }
  if (isYes(item.AC)) pts += 3;
  if (isYes(item.solar_heater)) pts += 2;
  if (isYes(item.storage)) pts += 2;

  // Τύπος
  if (item.category === 'house') pts += 5;
  else missing.push('δεν είναι κατοικία/μονοκατοικία (διαμέρισμα;)');
  if ((item.levels || 1) >= 2) pts += 2;

  // Παλαιότητα: μετράει το «ενεργό» έτος = το νεότερο από κατασκευή/ανακαίνιση
  const yr = Number(item.year_of_construction) || 0;
  const renovYr = isYes(item.renovated) ? (Number(item.renovationYear) || 0) : 0;
  const effYear = Math.max(yr, renovYr);
  let agePts = 0;
  if (effYear >= 2015) agePts = 8;
  else if (effYear >= 2010) agePts = 6;
  else if (effYear >= 2005) agePts = 4;
  else if (effYear >= 2000) agePts = 2;
  if (agePts) {
    pts += agePts;
    why.push(renovYr > yr ? `ανακαίνιση ${renovYr} +${agePts}` : `κατασκευή ${yr} +${agePts}`);
  }
  if (yr === 0) missing.push('άγνωστο έτος κατασκευής — θέλει έλεγχο');

  return { score: Math.max(0, Math.min(100, pts)), why, missing, flags };
}

function tierOf(score) {
  if (score >= 70) return { label: '⭐⭐⭐ Κορυφαίο match', color: '#2e7d32' };
  if (score >= 50) return { label: '⭐⭐ Πολύ καλό', color: '#ef6c00' };
  return { label: '⭐ Αξίζει μια ματιά', color: '#757575' };
}

function fmtListing(item, match, scored) {
  const { work, school } = cfg.referencePoints;
  let distances = '';
  if (!match.noCoords) {
    const dW = haversineKm(item.latitude, item.longitude, work.lat, work.lon).toFixed(1);
    const dS = haversineKm(item.latitude, item.longitude, school.lat, school.lon).toFixed(1);
    distances = `📏 ${dW} χλμ από δουλειά · ${dS} χλμ από σχολείο (ευθεία)`;
  } else {
    distances = '⚠️ Χωρίς συντεταγμένες στην αγγελία — θέλει έλεγχο με το μάτι';
  }
  const garage = item.garage === 'yes' || item.garage === '1';
  const heat = heatingLabel(item);
  const ec = ENERGY_CLASS[item.energyClass];
  const perks = [
    item.rooms ? `🛏️ ${item.rooms} υ/δ` : null,
    item.no_of_bathrooms ? `🛁 ${item.no_of_bathrooms} μπάνια${item.no_of_WC ? ' +' + item.no_of_WC + ' WC' : ''}` : null,
    garage ? '🅿️ <b>Γκαράζ: ΝΑΙ</b>' : '🅿️ Γκαράζ: όχι/δεν αναφέρεται',
    heat ? `🌡️ ${heat}${isYes(item.heatingUnderFloor) ? ' (ενδοδαπέδια)' : ''}` : null,
    ec && ec !== '—' ? `⚡ Ενεργειακή: ${ec}` : null,
    item.glassType ? `🪟 Τζάμια: ${item.glassType === 'Double' ? 'διπλά' : item.glassType === 'Triple' ? 'τριπλά' : item.glassType}` : null,
    isYes(item.garden) ? '🌳 Κήπος' : null,
    item.lotSize && Number(item.lotSize) > 0 ? `📐 Οικόπεδο ${item.lotSize} τ.μ.` : null,
    isYes(item.fireplace) ? '🔥 Τζάκι' : null,
    isYes(item.AC) ? '❄️ A/C' : null,
    isYes(item.solar_heater) ? '☀️ Ηλιακός' : null,
    item.furnished && item.furnished !== 'no' ? `🛋️ Επιπλωμένο: ${item.furnished}` : null,
    item.levels ? `🏠 Επίπεδα: ${item.levels}` : null,
    item.year_of_construction ? `🏗️ Έτος: ${item.year_of_construction}` : '🏗️ Έτος: άγνωστο ⚠️',
    isYes(item.renovated) && item.renovationYear ? `🔄 Ανακαίνιση: ${item.renovationYear}` : null,
    item.availability ? `📅 Διαθέσιμο από: ${item.availability}` : null,
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  const img = Array.isArray(item.images) && item.images.length
    ? `<img src="${item.images[0]}" width="420" style="border-radius:8px;display:block;margin:6px 0;">`
    : '';
  const mapLink = !match.noCoords
    ? ` · <a href="https://www.google.com/maps?q=${item.latitude},${item.longitude}">χάρτης</a>`
    : '';
  const tier = tierOf(scored.score);
  const missingLine = scored.missing.length
    ? `<div style="font-size:12.5px;color:#b23b3b;margin:4px 0;">❗ Λείπει: ${scored.missing.join(' · ')}</div>`
    : '';
  const flagsLine = scored.flags && scored.flags.length
    ? `<div style="font-size:12.5px;color:#1565c0;margin:4px 0;">${scored.flags.join('<br>')}</div>`
    : '';
  const whyLine = scored.why.length
    ? `<div style="font-size:11.5px;color:#888;margin:2px 0;">Γιατί: ${scored.why.join(' · ')}</div>`
    : '';

  return `
  <div style="border:1px solid #ddd;border-radius:10px;padding:14px;margin:12px 0;font-family:Segoe UI,sans-serif;">
    <div style="margin-bottom:4px;">
      <span style="background:${tier.color};color:#fff;border-radius:12px;padding:2px 10px;font-size:13px;font-weight:700;">${scored.score}/100</span>
      <span style="color:${tier.color};font-size:13px;font-weight:600;margin-left:6px;">${tier.label}</span>
    </div>
    <div style="font-size:17px;font-weight:700;">€${item.price} / μήνα — ${item.sq_meters} τ.μ. — ${match.zone}</div>
    <div style="color:#555;font-size:13px;margin:2px 0;">${distances}</div>
    ${img}
    <div style="font-size:13px;margin:6px 0;">${perks}</div>
    ${flagsLine}
    ${missingLine}
    ${whyLine}
    <div style="font-size:14px;"><a href="${item.url}">👉 Δες την αγγελία στο Spitogatos</a>${mapLink}</div>
  </div>`;
}

async function sendViaGraph(subject, html) {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  const from = process.env.MAIL_FROM || 'bill@emmanuela.gr';
  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MS_CLIENT_ID,
        client_secret: MS_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    }
  );
  if (!tokenRes.ok) throw new Error(`Graph token failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const { access_token } = await tokenRes.json();

  const mailRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: cfg.recipients.map((a) => ({ emailAddress: { address: a } })),
        },
        saveToSentItems: true,
      }),
    }
  );
  if (!mailRes.ok && mailRes.status !== 202) {
    throw new Error(`Graph sendMail failed: ${mailRes.status} ${await mailRes.text()}`);
  }
}

// Κοινό κανάλι αποστολής: Graph API → SMTP → dry-run.
async function deliver(subject, html) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM,
          MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  if (MS_TENANT_ID && MS_CLIENT_ID && MS_CLIENT_SECRET) {
    await sendViaGraph(subject, html);
    console.log(`Email εστάλη (Graph API) προς ${cfg.recipients.join(', ')}`);
    return true;
  }
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('— DRY RUN (δεν έχουν οριστεί Graph/SMTP secrets) —');
    console.log(`Θα στελνόταν email: "${subject}" προς ${cfg.recipients.join(', ')}`);
    return false;
  }
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transporter.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to: cfg.recipients.join(', '),
    subject,
    html,
  });
  console.log(`Email εστάλη (SMTP) προς ${cfg.recipients.join(', ')}`);
  return true;
}

// «Σήμα ζωής»: στέλνεται όταν ο έλεγχος δεν βρει τίποτα καινούργιο.
async function sendHeartbeat(stats) {
  const subject = `🏡 Σπίτι-Alert ✅ τίποτα νέο — έλεγχος ${stats.time}`;
  const html = `
    <div style="font-family:Segoe UI,sans-serif;max-width:640px;color:#444;">
      <h3 style="margin:4px 0;">🏡 Σπίτι-Alert — όλα καλά, τίποτα νέο</h3>
      <p style="font-size:13px;">Ο έλεγχος των ${stats.time} ολοκληρώθηκε κανονικά:</p>
      <ul style="font-size:13px;">
        <li>Σκαναρίστηκαν <b>${stats.scanned}</b> αγγελίες ενοικίασης (≤ €${cfg.maxPrice}).</li>
        <li><b>${stats.active}</b> ενεργές αγγελίες περνούν τα κριτήριά μας — όλες σας έχουν ήδη σταλεί.</li>
        <li>Καμία καινούργια αυτή τη φορά.</li>
      </ul>
      <p style="color:#999;font-size:11px;">Επόμενοι αυτόματοι έλεγχοι: 08:00 · 13:00 · 19:00. Αυτόματο μήνυμα από το spiti-alert.</p>
    </div>`;
  return deliver(subject, html);
}

async function sendEmail(matches) {
  const best = matches[0];
  const subject = matches.length === 1
    ? `🏡 Νέο σπίτι ${best.scored.score}/100: ${best.match.zone} — €${best.item.price}, ${best.item.sq_meters} τ.μ.`
    : `🏡 ${matches.length} νέες αγγελίες (καλύτερη ${best.scored.score}/100 — ${best.match.zone})`;
  const html = `
    <div style="font-family:Segoe UI,sans-serif;max-width:640px;">
      <h2 style="margin:4px 0;">🏡 Σπίτι-Alert</h2>
      <p style="color:#555;font-size:13px;">Νέες αγγελίες ενοικίασης ≤ €${cfg.maxPrice}, ≥ ${cfg.minSqMeters} τ.μ., μέσα στις περιοχές μας — ταξινομημένες με σκορ:</p>
      ${matches.map((m) => fmtListing(m.item, m.match, m.scored)).join('\n')}
      <p style="color:#999;font-size:11px;">Αυτόματο μήνυμα από το spiti-alert (GitHub Actions + Apify/Spitogatos). Σκορ = τ.μ., οικόπεδο, γκαράζ, τιμή, αποστάσεις, παροχές.</p>
    </div>`;

  return deliver(subject, html);
}

async function main() {
  if (!APIFY_TOKEN) { console.error('Λείπει το APIFY_TOKEN'); process.exit(1); }

  const seen = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : {};

  const items = await runActor();
  console.log(`Σκαναρίστηκαν ${items.length} αγγελίες συνολικά.`);

  const matches = [];
  let passedFilters = 0, belowScore = 0;
  for (const item of items) {
    const match = matchListing(item);
    if (!match) continue;
    passedFilters++;
    if (seen[item.id]) continue;
    const scored = scoreListing(item, match);
    if (scored.score < cfg.scoring.minScore) {
      belowScore++;
      console.log(`  ΧΑΜΗΛΟ ΣΚΟΡ (${scored.score}<${cfg.scoring.minScore}): €${item.price} · ${item.sq_meters} τ.μ. · ${match.zone} · λείπει: ${scored.missing.join(', ') || '—'} · ${item.url}`);
      continue;
    }
    matches.push({ item, match, scored });
  }
  matches.sort((a, b) => b.scored.score - a.scored.score);

  console.log(`Πέρασαν τα σκληρά φίλτρα: ${passedFilters} · Νέες με σκορ ≥ ${cfg.scoring.minScore}: ${matches.length} · Νέες με χαμηλό σκορ: ${belowScore}`);
  for (const m of matches) {
    console.log(`  ΝΕΟ [${m.scored.score}/100]: €${m.item.price} · ${m.item.sq_meters} τ.μ. · ${m.match.zone} · ${m.item.url}`);
  }

  if (matches.length > 0) {
    const sent = await sendEmail(matches);
    if (sent) {
      for (const m of matches) {
        seen[m.item.id] = {
          firstSeen: new Date().toISOString().slice(0, 10),
          price: m.item.price,
          zone: m.match.zone,
          score: m.scored.score,
          url: m.item.url,
        };
      }
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(seen, null, 1), 'utf8');
      console.log('Ενημερώθηκε το state/seen.json');
    } else {
      console.log('Dry-run: το state ΔΕΝ ενημερώθηκε — οι αγγελίες θα ξαναβρεθούν όταν ενεργοποιηθεί το email.');
    }
  } else {
    console.log('Τίποτα νέο. ✅');
    if (cfg.heartbeat) {
      const time = new Intl.DateTimeFormat('el-GR', {
        timeZone: 'Europe/Athens', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(new Date());
      await sendHeartbeat({ time, scanned: items.length, active: passedFilters });
    }
  }
}

module.exports = { matchListing, scoreListing, tierOf, haversineKm, fmtListing, sendEmail };

if (require.main === module) {
  main().catch((e) => { console.error('ΣΦΑΛΜΑ:', e.message); process.exit(1); });
}
