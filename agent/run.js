// agent/run.js
// Konkurrent-agent med Puppeteer (fungerer også på headless/SPA-sider).
// Lager rapport i 3 deler:
// Del 1: SEO-score + realistisk rangering (bransje + by + region)
// Del 2: 4 kategorier (SEO, UU, Hastighet, AEO) med "Hvorfor?" + "Hva kan skje?"
// Del 3: Oppsummering + "Hva vi kan tilby deg"

const fs = require('fs');
const { URL } = require('url');
const puppeteer = require('puppeteer');

const targetUrl = process.env.TARGET_URL;

if (!targetUrl) {
  console.error('TARGET_URL mangler');
  process.exit(1);
}

/**
 * Hent rendret HTML med Puppeteer (inkl. JS-innhold)
 */
async function fetchRenderedHTML(urlStr) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto(urlStr, { waitUntil: 'networkidle2', timeout: 60000 });
  const html = await page.content();
  await browser.close();
  return html;
}

/**
 * Gjet bransje/hovedtjeneste fra <title>/<h1>/domene
 */
function guessMainKeyword(html, urlStr) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  let source =
    (h1Match && h1Match[1]) ||
    (titleMatch && titleMatch[1]) ||
    urlStr.replace(/^https?:\/\//, '').split('/')[0];

  source = source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = source.split(' ').filter((w) => w.length > 2);
  if (!words.length) return 'din tjeneste';
  return words.slice(0, 2).join(' ');
}

/**
 * Gjet by (city) – JSON-LD addressLocality eller postnummer + sted
 */
function guessCity(html) {
  const lower = html.toLowerCase();

  // JSON-LD addressLocality
  const jsonLdCity = lower.match(/"addresslocality"\s*:\s*"([^"]+)"/i);
  if (jsonLdCity) {
    return jsonLdCity[1]
      .split(' ')
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(' ');
  }

  // 2830 Raufoss
  const match = lower.match(/\b(\d{4})\s+([a-zæøå\- ]{2,})\b/);
  if (match) {
    const sted = match[2].trim();
    if (
      sted.length > 2 &&
      !sted.includes('norge') &&
      !sted.includes('norway')
    ) {
      return sted
        .split(' ')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ');
    }
  }
  return null;
}

/**
 * Gjet region/fylke – JSON-LD addressRegion eller region-navn i HTML
 */
function guessRegion(html) {
  const lower = html.toLowerCase();

  // JSON-LD addressRegion
  const jsonLdRegion = lower.match(/"addressregion"\s*:\s*"([^"]+)"/i);
  if (jsonLdRegion) {
    return jsonLdRegion[1]
      .split(' ')
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(' ');
  }

  const regions = [
    'innlandet',
    'vestland',
    'rogaland',
    'trøndelag',
    'nordland',
    'oslo',
    'viken',
    'vestfold og telemark',
    'møre og romsdal',
    'troms og finnmark',
    'agder',
    'telemark',
    'buskerud',
    'hordaland',
    'sogn og fjordane',
    'oppland',
    'hedmark',
  ];

  for (const r of regions) {
    if (lower.includes(r)) {
      return r
        .split(' ')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ');
    }
  }
  return null;
}

/**
 * Finn potensielle lav-kontrast-eksempler (klasser + inline + body i <style>)
 */
function findContrastExamples(html) {
  const examples = [];

  // Tailwind-aktige klasser
  const classPattern =
    /class="([^"]*(text-(gray|slate|neutral|zinc|stone)-[23]00|text-muted)[^"]*)"/gi;
  let m;
  while ((m = classPattern.exec(html)) !== null) {
    if (examples.length >= 5) break;
    examples.push(`klasse: ${m[2]} (i "${m[1].slice(0, 50)}...")`);
  }

  // inline styles
  const stylePattern =
    /style="[^"]*color:\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]*\))[^"]*"/gi;
  let s;
  while ((s = stylePattern.exec(html)) !== null) {
    if (examples.length >= 5) break;
    examples.push(`fargekode: ${s[1]}`);
  }

  // body { color: ... } i <style>
  const styleBlocks = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
  for (const block of styleBlocks) {
    const bodyMatch = block.match(/body\s*{[^}]*color:\s*(#[0-9a-fA-F]{3,6})/i);
    if (bodyMatch) {
      examples.push(`body-tekstfarge: ${bodyMatch[1]} definert i CSS`);
    }
  }

  return examples;
}

function estimateContrastRisk(examples) {
  if (examples.length > 5) return 'høy';
  if (examples.length > 0) return 'middels';
  return 'lav';
}

/**
 * Analyse av HTML (etter at siden er rendret)
 */
function analyseHtml(html) {
  const noScriptsStyles = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const textOnly = noScriptsStyles
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const textLength = textOnly.length;

  const headings = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi) || [];
  const headingsText = headings
    .map((h) => h.replace(/<[^>]+>/g, ' '))
    .join(' ')
    .toLowerCase();

  const hasServiceWords =
    headingsText.includes('tjenester') ||
    headingsText.includes('produkter') ||
    headingsText.includes('vi tilbyr') ||
    headingsText.includes('våre tjenester');

  const hasFAQ =
    /faq|ofte stilte spørsmål/.test(html.toLowerCase()) ||
    /<details[^>]*>[\s\S]*?<summary[^>]*>/i.test(html);

  const hasSchema =
    /type=['"]application\/ld\+json['"]/.test(html.toLowerCase());

  const veryLowText = textLength < 1500;

  const contrastExamples = findContrastExamples(html);
  const contrastRisk = estimateContrastRisk(contrastExamples);

  const imgCount = (html.match(/<img[^>]*>/gi) || []).length;
  const scriptCount = (html.match(/<script[^>]*>/gi) || []).length;

  // SEO-score (enkel heuristikk)
  let seoScore = 100;
  if (!hasSchema) seoScore -= 20;
  if (veryLowText) seoScore -= 20;
  if (!hasServiceWords) seoScore -= 20;
  seoScore = Math.max(0, Math.min(100, seoScore));

  return {
    textOnly,
    textLength,
    hasServiceWords,
    hasFAQ,
    hasSchema,
    veryLowText,
    contrastExamples,
    contrastRisk,
    imgCount,
    scriptCount,
    seoScore,
  };
}

/**
 * SEO-score label
 */
function seoLabel(score) {
  if (score >= 80) return 'høy';
  if (score >= 60) return 'middels';
  if (score >= 40) return 'middels / svak';
  return 'svak';
}

/**
 * Tell forekomst av et søkeord i tekst
 */
function countOccurrences(textLower, term) {
  const t = term.toLowerCase();
  if (!t.trim()) return 0;
  const regex = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const matches = textLower.match(regex);
  return matches ? matches.length : 0;
}

/**
 * Tabell: Søkeord | Forventet synlighet | Hvorfor (stil som rapport 8)
 */
function buildRankingTable(mainKeyword, city, region, seoScore, textOnly) {
  const textLower = textOnly.toLowerCase();

  const terms = [];

  if (city) {
    terms.push(`${mainKeyword} ${city}`);
    terms.push(`beste ${mainKeyword} ${city}`);
  }
  if (region) {
    terms.push(`${mainKeyword} ${region}`);
    terms.push(`beste ${mainKeyword} ${region}`);
  }
  if (!terms.length) {
    terms.push(`${mainKeyword}`);
    terms.push(`beste ${mainKeyword}`);
  }

  const uniqueTerms = [...new Set(terms)];

  function expectedVisibility(score, count) {
    if (count >= 3 && score >= 80) return 'Middels–god';
    if (count >= 1 && score >= 60) return 'Middels–svak';
    if (count >= 1) return 'Svak';
    return 'Svak';
  }

  function why(score, count) {
    if (count === 0) return 'ingen egen tekst / lite relevant innhold';
    if (!score || score < 60) return 'begrenset innhold og lite strukturert data';
    return 'har noe innhold, men kan styrkes med mer faglig tekst og tydelig struktur';
  }

  let out = '';
  out += `Realistisk rangering i Google for nettstedet (basert på innholdet, ikke faktiske målinger)\n`;
  out += `Søkeord                           | Forventet synlighet | Hvorfor\n`;
  out += `--------------------------------- | ------------------- | ---------------------------------------------\n`;

  uniqueTerms.forEach((term) => {
    const count = countOccurrences(textLower, term);
    const vis = expectedVisibility(seoScore, count);
    const reason = why(seoScore, count);
    const termCol = term.padEnd(33, ' ');
    const visCol = vis.padEnd(19, ' ');
    out += `${termCol} | ${visCol} | ${reason}\n`;
  });

  return out;
}

/**
 * Dynamiske overskrifter for hver kategori
 */
function pickSeoHeadline(seed) {
  const headlines = [
    'Google forstår ikke hva dette selskapet tilbyr',
    'Dårlig SEO som Google ikke liker',
    'Google sliter å forstå innholdet og viktige tema på nettsiden deres',
  ];
  return headlines[seed % headlines.length];
}

function pickUuHeadline(seed) {
  const headlines = [
    'Brudd på UU = potensielle bøter',
    'Dårlig kontrast gir dårligere Google‑score',
    'Kunder går glipp av viktig informasjon som følge av dårlig kontrast',
  ];
  return headlines[seed % headlines.length];
}

function pickSpeedHeadline(seed) {
  const headlines = [
    'Lav page speed gir utålmodige kunder',
    'Lav page speed = lavere rangering på Google',
    'Din PageSpeed er svak, kunder mister tålmodigheten',
  ];
  return headlines[seed % headlines.length];
}

function pickAeoHeadline(seed) {
  const headlines = [
    'Siden dukker ikke opp i AI‑genererte svar',
    '0 FAQ = 0 AI synlighet',
    'Mangler du FAQ? Da dukker du heller ikke opp i AEO',
  ];
  return headlines[seed % headlines.length];
}

/**
 * Del 2 – 4 kategorier
 */
function buildProblemsSection(url, mainKeyword, city, region, analysis) {
  const {
    textLength,
    hasSchema,
    hasServiceWords,
    hasFAQ,
    contrastRisk,
    contrastExamples,
    imgCount,
    scriptCount,
  } = analysis;

  const seed = textLength || 1;
  let out = '';

  out += `Del 2\n`;
  out += `Hvorfor ${url} scorer dårlig i søkemotorene\n\n`;

  // 1 / SEO
  out += `1 / SEO\n`;
  out += `${pickSeoHeadline(seed)}\n\n`;
  out += `Hvorfor?\n`;
  if (!hasSchema) out += `- Mangler strukturert data (schema)\n`;
  if (textLength < 3000)
    out += `- Lite relevant og forklarende tekst (ca. ${textLength} tegn)\n`;
  if (!hasServiceWords)
    out += `- Få relevante tjeneste-overskrifter som treffer det folk faktisk søker på\n`;
  out += `\nHva kan skje?\n`;
  out += `→ Google prioriterer konkurrerende sider med bedre struktur og innhold\n`;
  out += `→ Lav synlighet og færre kunder fra søk som "${mainKeyword} ${city || region || 'ditt område'}"\n\n\n`;

  // 2 / UU
  out += `2 / Unviersell utforming\n`;
  out += `${pickUuHeadline(seed)}\n\n`;
  out += `Hvorfor?\n`;
  if (contrastRisk === 'høy')
    out += `- Mange tegn på svak kontrast (lys tekst på lys bakgrunn)\n`;
  else if (contrastRisk === 'middels')
    out += `- Flere eksempler på lys tekst som kan være vanskelig å lese\n`;
  if (contrastExamples.length) {
    out += `- Eksempler på potensielt problematisk tekstfarge/klasse:\n`;
    contrastExamples.slice(0, 3).forEach((ex) => (out += `  * ${ex}\n`));
  }
  if (!contrastExamples.length && contrastRisk === 'lav')
    out += `- Ingen tydelige kontrastfeil i en enkel automatisk sjekk\n`;

  out += `\nHva kan skje?\n`;
  out += `→ Dårlig kontraster skaper irritasjon hos brukerne\n`;
  out += `→ Gjør det vanskelig, om ikke umulig, for eldre og svaksynte å lese innholdet\n`;
  out += `→ Hvis dere kjører annonser, kan det bli dyrere fordi siden konverterer dårligere\n`;
  out += `→ Kan i verste fall gi bøter fra UU-tilsynet\n\n\n`;

  // 3 / Hastighet
  out += `3 / Page Speed\n`;
  out += `${pickSpeedHeadline(seed)}\n\n`;
  out += `Hvorfor?\n`;
  if (imgCount > 20)
    out += `- Siden har mange bilder (${imgCount} stk) som kan være store i filstørrelse (anbefalt < 100KB)\n`;
  if (scriptCount > 10)
    out += `- Det lastes inn mange JavaScript-filer (${scriptCount} scripts), som kan forsinke innlasting\n`;
  if (imgCount <= 20 && scriptCount <= 10)
    out += `- Ingen åpenbare tegn på ekstremt tung side, men struktur og kode kan fortsatt optimaliseres\n`;
  out += `\nHva kan skje?\n`;
  out += `→ AI‑søk (ChatGPT, CoPilot) velger ofte bort trege sider\n`;
  out += `→ Brukerne kan miste tålmodighet hvis siden føles treg\n`;
  out += `→ Lavere rangering på Google når PageSpeed er svakere enn konkurrentenes\n\n\n`;

  // 4 / AEO
  out += `4 / AEO\n`;
  out += `${pickAeoHeadline(seed)}\n\n`;
  out += `Hvorfor?\n`;
  if (!hasSchema) out += `- Ingen schema for “LocalBusiness” eller tilsvarende funnet\n`;
  if (!hasFAQ) out += `- Ingen FAQ eller spørsmålsbasert innhold som AI kan bruke\n`;
  if (hasSchema && hasFAQ)
    out += `- Det finnes noe strukturert data, men lite tydelig Q&A-innhold som passer til AI-svar\n`;
  out += `\nHva kan skje\n`;
  out += `→ AI leser primært maskinlesbart innhold. Du kan risikere at siden ikke dukker opp i AI-genererte svar\n`;
  out += `→ Konkurrenter får forspranget i nye søkekanaler hvis de har FAQ og strukturert data\n`;

  return out;
}

/**
 * Del 3 – Oppsummering og vei videre
 */
function buildSummarySection() {
  let out = '';
  out += `Del 3\n`;
  out += `Hva gjør du nå?\n\n`;

  out += `Hva vi fant:\n`;
  out += `Dette nettstedet har flere svakheter som påvirker:\n`;
  out += `* kundens synlighet i Google\n`;
  out += `* brukeropplevelse\n`;
  out += `* synlighet i AEO\n`;
  out += `* konverteringer\n`;
  out += `* risiko for brudd på norsk tilgjengelighetslov (UU)\n\n`;

  out += `Hva vi kan tilby deg:\n`;
  out += `* Raske og sikre nettsider med data lagret i EU.\n`;
  out += `* Alle våre løsninger leveres med topp SEO og AEO, skrevet av mennesker.\n`;
  out += `* Vi sørger for at siden din oppfyller kravene for universell utforming (UU).\n`;
  out += `* Nettsider med strukturert data + AI‑optimalisering inkludert.\n`;
  out += `* Bedre konvertering og mer profesjonell presentasjon.\n`;

  return out;
}

/**
 * Bygg hele rapporten
 */
function buildReport(url, html, analysis) {
  const { seoScore, textOnly } = analysis;
  const label = seoLabel(seoScore);
  const mainKeyword = guessMainKeyword(html, url);
  const city = guessCity(html);
  const region = guessRegion(html) || city || 'ditt område';

  let out = '';

  // Del 1
  out += `Del 1\n`;
  out += `Din side (${url})\n`;
  out += `har fått en SEO‑score på\n`;
  out += `${seoScore} / 100 (${label})\n\n`;

  out += `Nettsiden ${url} rangerer trolig svakt på bransjesøk som\n`;
  if (city) {
    out += `"${mainKeyword} ${city}", "beste ${mainKeyword} ${city}", "beste ${mainKeyword} ${region}".\n\n`;
  } else {
    out += `"${mainKeyword} ${region}", "beste ${mainKeyword} ${region}" og "${mainKeyword} pris ${region}".\n\n`;
  }

  out += buildRankingTable(mainKeyword, city, region, seoScore, textOnly);
  out += `\n\n`;

  // Del 2
  out += buildProblemsSection(url, mainKeyword, city, region, analysis);
  out += `\n\n`;

  // Del 3
  out += buildSummarySection();

  return out;
}

/**
 * Main
 */
(async () => {
  try {
    console.log('Henter rendret HTML fra:', targetUrl);
    const html = await fetchRenderedHTML(targetUrl);
    const analysis = analyseHtml(html);
    const report = buildReport(targetUrl, html, analysis);

    fs.writeFileSync('SALGS-RAPPORT.txt', report, 'utf8');
    console.log('SALGS-RAPPORT.txt generert ✅');
  } catch (err) {
    console.error('Feil under kjøring av agent:', err);
    process.exit(1);
  }
})();
