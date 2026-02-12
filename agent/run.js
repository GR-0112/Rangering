// agent/run.js
// Konkurrent-agent uten eksterne pakker.
// Analysere HTML på klassiske feil og generere en salgsrapport i 3 deler:
//
// Del 1: Oversikt + SEO-score + forventet rangering på søkeord (bransje + område)
// Del 2: Gjennomgang av feil i 4 kategorier (SEO, UU, Hastighet, AEO)
// Del 3: Oppsummering og "Hva vi kan tilby deg"

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const targetUrl = process.env.TARGET_URL;

if (!targetUrl) {
  console.error('TARGET_URL mangler');
  process.exit(1);
}

/**
 * Hent HTML (kun innebygde moduler)
 */
function fetchHTML(urlStr, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(new Error('For mange redirects'));
    }

    let url;
    try {
      url = new URL(urlStr);
    } catch {
      return reject(new Error('Ugyldig URL'));
    }

    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.get(url, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, urlStr).toString();
        res.resume();
        return resolve(fetchHTML(next, redirects + 1));
      }

      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
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
  if (!words.length) return 'deres tjeneste';
  return words.slice(0, 2).join(' ');
}

/**
 * Gjet by (sted) fra "2830 Raufoss" eller lignende
 */
function guessCity(html) {
  const lower = html.toLowerCase();
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
 * Gjet region/fylke ved å se etter fylkesnavn eller generelle områdeord
 */
function guessRegion(html) {
  const lower = html.toLowerCase();
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
    'hedmark'
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
 * Finn potensielle lav-kontrast-eksempler
 */
function findContrastExamples(html) {
  const examples = [];

  const classPattern =
    /class="([^"]*(text-gray-300|text-gray-200|text-gray-400|text-slate-300|text-muted)[^"]*)"/gi;
  let m;
  while ((m = classPattern.exec(html)) !== null) {
    if (examples.length >= 5) break;
    examples.push(`klasse: ${m[2]} (i "${m[1].slice(0, 40)}...")`);
  }

  const stylePattern =
    /style="[^"]*color:\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]*\))[^"]*"/gi;
  let s;
  while ((s = stylePattern.exec(html)) !== null) {
    if (examples.length >= 5) break;
    examples.push(`fargekode: ${s[1]}`);
  }

  // Se også etter body { color: ... } i inline <style>
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
 * Sjekk alt-tekst på bilder
 */
function countMissingAlt(html) {
  const imgTags = html.match(/<img[^>]*>/gi) || [];
  let missing = 0;
  for (const tag of imgTags) {
    const hasAlt = /alt\s*=\s*"/i.test(tag);
    const emptyAlt = /alt\s*=\s*"\s*"/i.test(tag);
    if (!hasAlt || emptyAlt) missing++;
  }
  return missing;
}

/**
 * Enkel HTML-analyse
 */
function analyseHtml(html) {
  const textOnly = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
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

  const linkMatches = html.match(/<a\s+[^>]*href=/gi) || [];
  const linkCount = linkMatches.length;

  const navPresent = /<nav[^>]*>/i.test(html);

  const contrastExamples = findContrastExamples(html);
  const contrastRisk = estimateContrastRisk(contrastExamples);

  const missingAltCount = countMissingAlt(html);

  const imgCount = (html.match(/<img[^>]*>/gi) || []).length;
  const scriptCount = (html.match(/<script[^>]*>/gi) || []).length;

  // SEO-score (enkel heuristikk)
  let seoScore = 100;
  if (!hasSchema) seoScore -= 20;
  if (veryLowText) seoScore -= 20;
  if (!hasServiceWords) seoScore -= 20;
  seoScore = Math.max(0, Math.min(100, seoScore));

  return {
    textLength,
    textOnly,
    hasServiceWords,
    hasFAQ,
    hasSchema,
    veryLowText,
    contrastExamples,
    contrastRisk,
    linkCount,
    navPresent,
    missingAltCount,
    imgCount,
    scriptCount,
    seoScore
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
 * Lag "Realistisk rangering"-tabell i stil med rapport 8
 * Søkeord | Forventet synlighet | Hvorfor
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

  function occ(term) {
    const t = term.toLowerCase();
    if (!t.trim()) return 0;
    const regex = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const matches = textLower.match(regex);
    return matches ? matches.length : 0;
  }

  function expectedVisibility(score, count) {
    if (count >= 3 && score >= 80) return 'Middels–god';
    if (count >= 1 && score >= 60) return 'Middels–svak';
    if (count >= 1) return 'Svak';
    return 'Svak';
  }

  function why(score, count) {
    if (count === 0) return 'ingen egen tekst / lite relevant innhold';
    if (!score || score < 60) return 'begrenset innhold og lite strukturert data';
    return 'har noe innhold, men kan styrkes med mer faglig tekst og struktur';
  }

  let out = '';
  out += `Realistisk rangering i Google for nettstedet (basert på innholdet, ikke faktiske målinger)\n`;
  out += `Søkeord                           | Forventet synlighet | Hvorfor\n`;
  out += `--------------------------------- | ------------------- | ---------------------------------------------\n`;

  uniqueTerms.forEach((term) => {
    const count = occ(term);
    const vis = expectedVisibility(seoScore, count);
    const reason = why(seoScore, count);
    const termCol = term.padEnd(33, ' ');
    const visCol = vis.padEnd(19, ' ');
    out += `${termCol} | ${visCol} | ${reason}\n`;
  });

  return out;
}

/**
 * Dynamiske overskrifter per kategori – basert på tekster du liker
 */
function pickSeoHeadline(seed) {
  const headlines = [
    'Google forstår ikke hva dette selskapet tilbyr',
    'Dårlig SEO som Google ikke liker',
    'Google sliter med å forstå innholdet på nettsiden',
    'Dårlig innhold og hierarki gir lavere rangering i søkemotorene'
  ];
  return headlines[seed % headlines.length];
}

function pickUuHeadline(seed) {
  const headlines = [
    'Brudd på UU = potensielle bøter',
    'Dårlig kontrast gir dårligere Google‑score',
    'Kunder går glipp av viktig informasjon på grunn av dårlig kontrast',
    'Siden bryter sannsynligvis UU‑krav – det gir risiko for bøter'
  ];
  return headlines[seed % headlines.length];
}

function pickSpeedHeadline(seed) {
  const headlines = [
    'Lav page speed gir utålmodige kunder',
    'Lav page speed = lavere rangering på Google',
    'Din PageSpeed er svak, kunder mister tålmodigheten',
    'Ikke kast bort tiden til dine besøkende – få opp farta'
  ];
  return headlines[seed % headlines.length];
}

function pickAeoHeadline(seed) {
  const headlines = [
    'Siden dukker ikke opp i AI‑genererte svar',
    '0 FAQ = 0 AI‑synlighet',
    'Mangler du FAQ? Da dukker du heller ikke opp i AEO',
    'Dette er obligatorisk hvis du vil vinne i fremtidens søk'
  ];
  return headlines[seed % headlines.length];
}

/**
 * Del 2 – "Hvorfor [url] scorer dårlig..."
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
    scriptCount
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
    out += `- Lite faglig og forklarende tekst (ca. ${textLength} tegn)\n`;
  if (!hasServiceWords)
    out += `- Få relevante tjeneste-overskrifter som treffer søkeord målgruppen bruker\n`;
  if (hasSchema && textLength >= 3000 && hasServiceWords)
    out += `- Det finnes noe struktur, men innholdet kan fortsatt styrkes for å gi Google tydeligere signaler\n`;

  out += `\nHva kan skje?\n`;
  out += `→ Google prioriterer konkurrerende sider med bedre struktur og innhold\n`;
  out += `→ Lav synlighet og færre kunder fra søk som "${mainKeyword} ${city || region || 'ditt område'}"\n\n\n`;

  // 2 / Universell utforming
  out += `2 / Universell utforming\n`;
  out += `${pickUuHeadline(seed)}\n\n`;
  out += `Hvorfor?\n`;
  if (contrastRisk === 'høy')
    out += `- Mange tegn på svak kontrast (lys tekst mot lys bakgrunn)\n`;
  else if (contrastRisk === 'middels')
    out += `- Flere eksempler på lys tekst som kan være vanskelig å lese\n`;
  if (contrastExamples.length) {
    out += `- Eksempler på potensielt problematisk tekstfarge/klasse:\n`;
    contrastExamples.slice(0, 3).forEach((ex) => (out += `  * ${ex}\n`));
  }
  if (!contrastExamples.length && contrastRisk === 'lav')
    out += `- Ingen åpenbare kontrastproblemer i enkel automatisk kontroll\n`;

  out += `\nHva kan skje?\n`;
  out += `→ Dårlig kontrast skaper irritasjon hos brukerne\n`;
  out += `→ Gjør det vanskelig, om ikke umulig, for eldre og svaksynte å lese innholdet\n`;
  out += `→ Hvis dere kjører annonser, kan dårlig UU gi lavere effekt og dyrere klikk\n`;
  out += `→ Kan i verste fall gi bøter fra UU-tilsynet\n\n\n`;

  // 3 / Page Speed
  out += `3 / Page Speed\n`;
  out += `${pickSpeedHeadline(seed)}\n\n`;
  out += `Hvorfor?\n`;
  if (imgCount > 20)
    out += `- Siden har mange bilder (${imgCount} stk) som kan være store i filstørrelse\n`;
  if (scriptCount > 10)
    out += `- Det lastes inn mange JavaScript-filer (${scriptCount} scripts), noe som kan forsinke innholdet\n`;
  if (imgCount <= 20 && scriptCount <= 10)
    out += `- Ingen åpenbare tegn på ekstremt tung side, men struktur og kode kan fortsatt optimaliseres\n`;

  out += `\nHva kan skje?\n`;
  out += `→ AI‑søk (ChatGPT, CoPilot) velger ofte bort trege sider\n`;
  out += `→ Brukerne kan miste tålmodighet hvis siden oppleves treg\n`;
  out += `→ Lavere rangering på Google når PageSpeed er svakere enn konkurrentenes\n\n\n`;

  // 4 / AEO – AI-synlighet
  out += `4 / AEO (AI-synlighet)\n`;
  out += `${pickAeoHeadline(seed)}\n\n`;
  out += `Hvorfor?\n`;
  if (!hasSchema) out += `- Ingen schema for "LocalBusiness" eller andre strukturtyper funnet\n`;
  if (!hasFAQ) out += `- Ingen FAQ eller spørsmålsbasert innhold funnet\n`;
  if (hasSchema && hasFAQ)
    out += `- Det finnes noe strukturert data, men lite tydelig Q&A-innhold som AI og Google kan bruke i svar\n`;

  out += `\nHva kan skje?\n`;
  out += `→ AI leser primært maskinlesbart innhold. Dere kan risikere at siden ikke dukker opp i AI-genererte svar\n`;
  out += `→ Konkurrenter som har FAQ og strukturert data får et forsprang i nye søkekanaler\n`;

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
 * Bygg hele rapporten (Del 1 + Del 2 + Del 3)
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

  out += `Nettsiden ${url} rangerer trolig svakere enn den kunne på bransjesøk som\n`;
  if (city) {
    out += `"${mainKeyword} ${city}", "beste ${mainKeyword} ${city}"`;
    out += region && region !== city ? ` og "${mainKeyword} ${region}".\n\n` : `. \n\n`;
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
    console.log('Henter HTML fra:', targetUrl);
    const html = await fetchHTML(targetUrl);
    const analysis = analyseHtml(html);
    const report = buildReport(targetUrl, html, analysis);

    fs.writeFileSync('SALGS-RAPPORT.txt', report, 'utf8');
    console.log('SALGS-RAPPORT.txt generert ✅');
  } catch (err) {
    console.error('Feil under kjøring av agent:', err);
    process.exit(1);
  }
})();
