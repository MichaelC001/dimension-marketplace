#!/usr/bin/env node
// Practice job-application sites for the browser benchmark. No dependencies, no external network.
//   node bench/sites/server.mjs --port 4777
// Five fictional careers sites of rising difficulty, each: listing -> job detail -> application.
// Every submission is recorded and checked against bench/applicant.json.
//   GET /__results  -> per-site submitted count, fieldsCorrect, missing/wrong fields
//   POST /__reset   -> forget all submissions
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const applicant = JSON.parse(readFileSync(new URL("../applicant.json", import.meta.url), "utf8"));

// ---------------------------------------------------------------- expectations

const fullName = `${applicant.firstName} ${applicant.lastName}`;
const experienceBucket = (y) => (y <= 1 ? "0-1" : y <= 4 ? "2-4" : y <= 9 ? "5-9" : "10+");

const CITIES = [
  { id: "c-2207", name: "Riverside, CA" },
  { id: "c-3141", name: "Riverton, OR" },
  { id: "c-4410", name: "River Falls, WI" },
  { id: "c-5023", name: "Rivertown, GA" },
  { id: "c-6118", name: "Rockport, ME" },
  { id: "c-7031", name: "Portland, OR" },
  { id: "c-7032", name: "Salem, OR" },
  { id: "c-8120", name: "Springfield, IL" },
  { id: "c-9001", name: "Brookline, MA" },
];
const applicantCity = CITIES.find((c) => c.name.toLowerCase().startsWith(applicant.city.toLowerCase() + ","));
if (!applicantCity) throw new Error(`applicant city ${applicant.city} is not in the Hooli city list`);

const JOBS = [
  { key: "fe", title: "Frontend Engineer", team: "Web Platform", location: "Remote (US)" },
  { key: "be", title: "Backend Engineer", team: "Core Services", location: "Remote (US)" },
  { key: "pd", title: "Product Designer", team: "Design", location: "Hybrid" },
  { key: "sre", title: "Site Reliability Engineer", team: "Infrastructure", location: "On-site" },
];

// kinds: text (case/whitespace-insensitive), email, phone (digits), url, exact, set, letter, prefix
const SITES = {
  acme: {
    name: "Acme Robotics", color: "#c0392b", font: "Georgia, serif",
    ids: { fe: "1042", be: "1043", pd: "1051", sre: "1060" },
    tagline: "Building friendly robots since 1987.",
    expect: {
      fullName: ["text", fullName],
      email: ["email", applicant.email],
      phone: ["phone", applicant.phone],
      linkedin: ["url", applicant.linkedin],
    },
  },
  globex: {
    name: "Globex Corporation", color: "#1f6feb", font: "Helvetica, Arial, sans-serif",
    ids: { fe: "FE-2201", be: "BE-2202", pd: "PD-2210", sre: "SR-2230" },
    tagline: "Tomorrow's infrastructure, today.",
    expect: {
      firstName: ["text", applicant.firstName],
      lastName: ["text", applicant.lastName],
      email: ["email", applicant.email],
      phone: ["phone", applicant.phone],
      experience: ["exact", experienceBucket(applicant.yearsExperience)],
      city: ["text", applicant.city],
    },
  },
  initech: {
    name: "Initech", color: "#6b4f9e", font: "Verdana, sans-serif",
    ids: { fe: "frontend-engineer", be: "backend-engineer", pd: "product-designer", sre: "sre" },
    tagline: "Software for the modern enterprise.",
    expect: {
      fullName: ["text", fullName],
      email: ["email", applicant.email],
      phone: ["phone", applicant.phone],
      workAuth: ["exact", applicant.workAuthorized ? "yes" : "no"],
      skills: ["set", applicant.skills],
      consent: ["exact", "on"],
    },
  },
  umbrella: {
    name: "Umbrella Health", color: "#a0522d", font: "'Trebuchet MS', sans-serif",
    ids: { fe: "r-88213", be: "r-88214", pd: "r-88230", sre: "r-88241" },
    tagline: "Caring for people, powered by software.",
    expect: {
      firstName: ["text", applicant.firstName],
      lastName: ["text", applicant.lastName],
      email: ["email", applicant.email],
      phone: ["phone", applicant.phone],
      linkedin: ["url", applicant.linkedin],
      yearsExperience: ["exact", String(applicant.yearsExperience)],
    },
  },
  hooli: {
    name: "Hooli", color: "#0f9d58", font: "system-ui, sans-serif",
    ids: { fe: "fe", be: "be", pd: "pd", sre: "sre" },
    tagline: "Making the world a better place.",
    expect: {
      fullName: ["text", fullName],
      email: ["email", applicant.email],
      city: ["prefix", applicant.city],
      cityId: ["exact", applicantCity.id],
      coverLetter: ["letter", applicant.coverLetter],
    },
  },
};

const norm = (s) => String(s ?? "").normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
const digits = (s) => String(s ?? "").replace(/\D/g, "");
const url = (s) => norm(s).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");

function matches(kind, expected, got) {
  switch (kind) {
    case "text": case "email": case "exact": return norm(got) === norm(expected);
    case "prefix": return norm(got).startsWith(norm(expected));
    case "phone": { const e = digits(expected), g = digits(got); return g === e || (g.length >= 10 && e.endsWith(g)); }
    case "url": return url(got) === url(expected);
    case "letter": return norm(got).replace(/[.!\s]+$/, "") === norm(expected).replace(/[.!\s]+$/, "");
    case "set": return [...new Set(got.map(norm))].sort().join("|") === [...new Set(expected.map(norm))].sort().join("|");
    default: throw new Error(`unknown kind ${kind}`);
  }
}

function checkSubmission(site, jobId, params) {
  const missing = [];
  const wrong = [];
  const fields = {};
  if (jobId !== SITES[site].ids.fe) wrong.push({ field: "job", expected: SITES[site].ids.fe, got: jobId });
  for (const [field, [kind, expected]] of Object.entries(SITES[site].expect)) {
    const got = kind === "set" ? params.getAll(field) : params.get(field);
    fields[field] = got;
    const empty = kind === "set" ? got.length === 0 : !String(got ?? "").trim();
    if (empty) missing.push(field);
    else if (!matches(kind, expected, got)) wrong.push({ field, expected, got });
  }
  return { jobId, fields, missing, wrong, fieldsCorrect: missing.length === 0 && wrong.length === 0 };
}

const submissions = Object.fromEntries(Object.keys(SITES).map((s) => [s, []]));

function results(base) {
  const sites = {};
  for (const [site, list] of Object.entries(submissions)) {
    const last = list.at(-1);
    sites[site] = {
      url: `${base}/${site}`,
      submitted: list.length,
      fieldsCorrect: Boolean(last?.fieldsCorrect),
      success: Boolean(last?.fieldsCorrect),
      missing: last ? last.missing : Object.keys(SITES[site].expect),
      wrong: last ? last.wrong : [],
      lastSubmittedAt: last?.at ?? null,
      last: last ? { jobId: last.jobId, fields: last.fields } : null,
    };
  }
  return { applicant: applicant.email, sites };
}

// ---------------------------------------------------------------- html

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(siteKey, title, body, { script = "", overlay = false } = {}) {
  const s = SITES[siteKey];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} | ${esc(s.name)} Careers</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;font-family:${s.font};color:#222;background:#f6f6f4}
header{background:${s.color};color:#fff;padding:14px 28px;display:flex;align-items:baseline;gap:16px}
header a{color:#fff;text-decoration:none;font-weight:bold;font-size:20px}
header span{opacity:.85;font-size:13px}
main{max-width:760px;margin:28px auto;background:#fff;padding:24px 32px;border-radius:6px;box-shadow:0 1px 4px #0002}
h1{margin-top:0}
.job{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #eee;padding:12px 0}
.job small{color:#666}
label{display:block;margin:14px 0 4px;font-weight:600}
input[type=text],input[type=email],input[type=tel],input[type=url],input[type=number],select,textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #bbb;border-radius:4px;font:inherit}
.inline label{display:inline;font-weight:normal;margin:0 14px 0 4px}
.btn{background:${s.color};color:#fff;border:0;padding:10px 20px;border-radius:4px;font:inherit;font-weight:bold;cursor:pointer;text-decoration:none;display:inline-block;margin-top:18px}
.btn.secondary{background:#888}
.error{color:#b00020;font-size:13px;margin-top:4px}
.errors{background:#fde8ea;border:1px solid #f5b5bd;color:#b00020;padding:10px 14px;border-radius:4px}
.hidden{display:none}
footer{text-align:center;color:#888;font-size:12px;margin:24px}
</style></head><body>
<header><a href="/${siteKey}">${esc(s.name)} Careers</a><span>${esc(s.tagline)}</span></header>
<main>${body}</main>
<footer>&copy; ${esc(s.name)} &mdash; a fictional company used for browser-agent practice.</footer>
${overlay ? cookieOverlay() : ""}
${script ? `<script>${script}</script>` : ""}
</body></html>`;
}

function listing(site) {
  const s = SITES[site];
  const rows = JOBS.map((j) => `<div class="job"><div><a href="/${site}/jobs/${s.ids[j.key]}"><strong>${esc(j.title)}</strong></a><br><small>${esc(j.team)} &middot; ${esc(j.location)}</small></div><a class="btn secondary" href="/${site}/jobs/${s.ids[j.key]}">View role</a></div>`).join("");
  return `<h1>Open positions</h1><p>Join ${esc(s.name)}. We are hiring across ${JOBS.length} teams.</p>${rows}`;
}

function detail(site, job) {
  const s = SITES[site];
  const cta = site === "hooli" ? "Quick apply" : "Apply for this job";
  return `<p><a href="/${site}">&larr; All jobs</a></p><h1>${esc(job.title)}</h1><p><small>${esc(job.team)} &middot; ${esc(job.location)} &middot; Req ${esc(s.ids[job.key])}</small></p>
<h3>About the role</h3><p>You will work with a small, senior team shipping ${esc(job.team.toLowerCase())} work used by millions of fictional customers.</p>
<h3>You have</h3><ul><li>3+ years of relevant experience</li><li>Care for quality and accessibility</li><li>Clear written communication</li></ul>
<a class="btn" href="/${site}/jobs/${s.ids[job.key]}/apply">${cta}</a>`;
}

function formHeader(site, job) {
  return `<p><a href="/${site}/jobs/${SITES[site].ids[job.key]}">&larr; Back to job</a></p><h1>Apply: ${esc(job.title)}</h1>`;
}

// (1) Acme: one simple form.
function acmeForm(action, job) {
  return `${formHeader("acme", job)}<form method="post" action="${action}">
<label for="fullName">Full name</label><input type="text" id="fullName" name="fullName" required>
<label for="email">Email</label><input type="email" id="email" name="email" required>
<label for="phone">Phone</label><input type="tel" id="phone" name="phone" required>
<label for="linkedin">LinkedIn profile</label><input type="url" id="linkedin" name="linkedin">
<button class="btn" type="submit">Submit application</button></form>`;
}

// (2) Globex: two steps in one form, Next button, select dropdown.
function globexForm(action, job) {
  const body = `${formHeader("globex", job)}<p id="stepLabel">Step 1 of 2: About you</p><form method="post" action="${action}" id="app">
<fieldset id="step1" style="border:0;padding:0">
<label for="firstName">First name</label><input type="text" id="firstName" name="firstName" required>
<label for="lastName">Last name</label><input type="text" id="lastName" name="lastName" required>
<label for="email">Email address</label><input type="email" id="email" name="email" required>
<button class="btn" type="button" id="next">Next</button></fieldset>
<fieldset id="step2" class="hidden" style="border:0;padding:0">
<label for="phone">Mobile phone</label><input type="tel" id="phone" name="phone" required disabled>
<label for="experience">Years of professional experience</label><select id="experience" name="experience" required disabled>
<option value="">Select...</option><option value="0-1">0-1 years</option><option value="2-4">2-4 years</option><option value="5-9">5-9 years</option><option value="10+">10+ years</option></select>
<label for="city">Current city</label><input type="text" id="city" name="city" required disabled>
<label for="referral">Referral code (optional)</label><input type="text" id="referral" name="referral" disabled>
<button class="btn secondary" type="button" id="back">Back</button> <button class="btn" type="submit">Submit application</button></fieldset></form>`;
  const script = `
const s1=document.getElementById('step1'),s2=document.getElementById('step2'),label=document.getElementById('stepLabel');
document.getElementById('next').onclick=()=>{for(const el of s1.querySelectorAll('input')){if(!el.reportValidity())return;}
s1.classList.add('hidden');s2.classList.remove('hidden');s2.querySelectorAll('input,select').forEach(e=>e.disabled=false);
for(const el of s1.querySelectorAll('input')){const h=document.createElement('input');h.type='hidden';h.name=el.name;h.value=el.value;h.dataset.copy='1';s2.appendChild(h);}
s1.querySelectorAll('input').forEach(e=>e.disabled=true);label.textContent='Step 2 of 2: Experience';document.getElementById('phone').focus();};
document.getElementById('back').onclick=()=>{s2.querySelectorAll('[data-copy]').forEach(e=>e.remove());s1.querySelectorAll('input').forEach(e=>e.disabled=false);
s2.classList.add('hidden');s1.classList.remove('hidden');label.textContent='Step 1 of 2: About you';};`;
  return { body, script };
}

// (3) Initech: radio, checkboxes, required consent, client-side validation errors.
function initechForm(action, job) {
  const skills = ["JavaScript", "TypeScript", "React", "Python", "Go", "Rust"];
  const body = `${formHeader("initech", job)}<div id="summary" class="errors hidden" role="alert"></div><form method="post" action="${action}" id="app" novalidate>
<label for="fullName">Full name *</label><input type="text" id="fullName" name="fullName"><div class="error" data-for="fullName"></div>
<label for="email">Email *</label><input type="text" id="email" name="email"><div class="error" data-for="email"></div>
<label for="phone">Phone number *</label><input type="text" id="phone" name="phone" placeholder="(555) 555-5555"><div class="error" data-for="phone"></div>
<label>Are you legally authorized to work in the US? *</label><div class="inline">
<input type="radio" id="wa-yes" name="workAuth" value="yes"><label for="wa-yes">Yes</label>
<input type="radio" id="wa-no" name="workAuth" value="no"><label for="wa-no">No</label></div><div class="error" data-for="workAuth"></div>
<label>Skills (select all that apply) *</label><div class="inline">
${skills.map((k) => `<input type="checkbox" id="sk-${k}" name="skills" value="${k}"><label for="sk-${k}">${k}</label>`).join("\n")}</div><div class="error" data-for="skills"></div>
<div class="inline" style="margin-top:18px"><input type="checkbox" id="consent" name="consent"><label for="consent">I consent to Initech storing my data for recruiting purposes. *</label></div><div class="error" data-for="consent"></div>
<button class="btn" type="submit">Submit application</button></form>`;
  const script = `
const f=document.getElementById('app'),sum=document.getElementById('summary');
f.addEventListener('submit',(ev)=>{const errs={};const v=(n)=>f.elements[n].value.trim();
if(!v('fullName'))errs.fullName='Full name is required.';
if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v('email')))errs.email='Enter a valid email address.';
if(v('phone').replace(/\\D/g,'').length<10)errs.phone='Phone number must have at least 10 digits.';
if(!f.querySelector('input[name=workAuth]:checked'))errs.workAuth='Please answer the work authorization question.';
if(!f.querySelector('input[name=skills]:checked'))errs.skills='Select at least one skill.';
if(!f.elements.consent.checked)errs.consent='You must consent to data processing to apply.';
document.querySelectorAll('.error').forEach(e=>e.textContent=errs[e.dataset.for]||'');
const n=Object.keys(errs).length;if(n){ev.preventDefault();sum.textContent='Please fix '+n+' error'+(n>1?'s':'')+' below.';sum.classList.remove('hidden');window.scrollTo(0,0);}});`;
  return { body, script };
}

// (4) Umbrella: cookie overlay first, then form, then an "are you sure" confirm page.
function cookieOverlay() {
  return `<div id="cookie-overlay" style="position:fixed;inset:0;background:#000a;z-index:1000;display:flex;align-items:flex-end;justify-content:center">
<div style="background:#fff;max-width:720px;width:100%;padding:22px 28px;border-radius:8px 8px 0 0;font-family:sans-serif">
<h2 style="margin-top:0">We value your privacy</h2><p>We use cookies to improve your experience and analyze traffic. You must choose an option to continue.</p>
<button class="btn secondary" type="button" onclick="umbrellaConsent('essential')">Essential only</button>
<button class="btn" type="button" onclick="umbrellaConsent('all')">Accept all cookies</button></div></div>
<script>function umbrellaConsent(v){document.cookie='umbrella_consent='+v+'.${consentEpoch}; path=/umbrella';document.getElementById('cookie-overlay').remove();}</script>`;
}

function umbrellaForm(action, job) {
  return `${formHeader("umbrella", job)}<form method="post" action="${action}">
<label for="firstName">Legal first name</label><input type="text" id="firstName" name="firstName" required>
<label for="lastName">Legal last name</label><input type="text" id="lastName" name="lastName" required>
<label for="email">Email</label><input type="email" id="email" name="email" required>
<label for="phone">Phone</label><input type="tel" id="phone" name="phone" required>
<label for="linkedin">LinkedIn URL</label><input type="url" id="linkedin" name="linkedin" required>
<label for="yearsExperience">Total years of experience</label><input type="number" id="yearsExperience" name="yearsExperience" min="0" max="60" required>
<button class="btn" type="submit">Review application</button></form>`;
}

function umbrellaConfirm(confirmAction, editHref, params) {
  const fields = Object.keys(SITES.umbrella.expect);
  const rows = fields.map((f) => `<tr><th style="text-align:left;padding:4px 16px 4px 0">${esc(f)}</th><td>${esc(params.get(f))}</td></tr>`).join("");
  const hidden = fields.map((f) => `<input type="hidden" name="${esc(f)}" value="${esc(params.get(f))}">`).join("");
  return `<h1>Are you sure?</h1><p>Please review your application. It has <strong>not</strong> been submitted yet.</p><table>${rows}</table>
<form method="post" action="${confirmAction}">${hidden}<a class="btn secondary" href="${editHref}">Go back and edit</a> <button class="btn" type="submit">Yes, submit my application</button></form>`;
}

// (5) Hooli: login-free quick apply with autocomplete city and cover letter textarea.
function hooliForm(action, job) {
  const body = `${formHeader("hooli", job)}<p>No account needed. Quick apply takes about a minute.</p><div id="summary" class="errors hidden" role="alert"></div>
<form method="post" action="${action}" id="app">
<label for="fullName">Your name</label><input type="text" id="fullName" name="fullName" required>
<label for="email">Email</label><input type="email" id="email" name="email" required>
<label for="city">City</label><div style="position:relative"><input type="text" id="city" name="city" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="city-list" autocomplete="off" placeholder="Start typing and choose from the list" required>
<ul id="city-list" role="listbox" class="hidden" style="position:absolute;left:0;right:0;top:100%;margin:0;padding:0;list-style:none;background:#fff;border:1px solid #bbb;z-index:10"></ul></div>
<input type="hidden" id="cityId" name="cityId">
<label for="coverLetter">Cover letter</label><textarea id="coverLetter" name="coverLetter" rows="6" maxlength="1000" required></textarea><div id="count" style="font-size:12px;color:#666">0 / 1000</div>
<button class="btn" type="submit">Send application</button></form>`;
  const script = `
const city=document.getElementById('city'),list=document.getElementById('city-list'),cityId=document.getElementById('cityId'),sum=document.getElementById('summary');
let items=[],active=-1,timer;
function render(){list.innerHTML='';items.forEach((c,i)=>{const li=document.createElement('li');li.role='option';li.id='city-opt-'+i;li.textContent=c.name;li.dataset.id=c.id;
li.style.cssText='padding:8px;cursor:pointer;'+(i===active?'background:#e6f4ea':'');li.onmousedown=(e)=>{e.preventDefault();choose(i);};list.appendChild(li);});
const open=items.length>0;list.classList.toggle('hidden',!open);city.setAttribute('aria-expanded',String(open));}
function choose(i){city.value=items[i].name;cityId.value=items[i].id;items=[];active=-1;render();}
city.addEventListener('input',()=>{cityId.value='';clearTimeout(timer);const q=city.value.trim();if(q.length<2){items=[];render();return;}
timer=setTimeout(async()=>{const r=await fetch('/hooli/api/cities?q='+encodeURIComponent(q));items=await r.json();active=items.length?0:-1;render();},250);});
city.addEventListener('keydown',(e)=>{if(!items.length)return;if(e.key==='ArrowDown'){active=(active+1)%items.length;render();e.preventDefault();}
else if(e.key==='ArrowUp'){active=(active-1+items.length)%items.length;render();e.preventDefault();}
else if(e.key==='Enter'||e.key==='Tab'){if(active>=0){choose(active);if(e.key==='Enter')e.preventDefault();}}else if(e.key==='Escape'){items=[];render();}});
city.addEventListener('blur',()=>setTimeout(()=>{items=[];render();},150));
const cl=document.getElementById('coverLetter'),count=document.getElementById('count');cl.addEventListener('input',()=>count.textContent=cl.value.length+' / 1000');
document.getElementById('app').addEventListener('submit',(e)=>{if(!cityId.value){e.preventDefault();sum.textContent='Please choose your city from the suggestions list.';sum.classList.remove('hidden');city.focus();}});`;
  return { body, script };
}

function thanks(site) {
  const ref = `${site.toUpperCase()}-${String(Date.now()).slice(-6)}`;
  return `<h1>Application received</h1><p>Thank you for applying. Your reference number is <strong>${ref}</strong>.</p><p>We review every application and will be in touch by email.</p><p><a href="/${site}">Back to all jobs</a></p>`;
}

// ---------------------------------------------------------------- server

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}
const json = (res, status, value) => send(res, status, JSON.stringify(value, null, 2), "application/json");

// The consent cookie carries the reset epoch so a persistent browser profile sees the overlay again after /__reset.
let consentEpoch = Date.now().toString(36);
function hasConsent(req) {
  return new RegExp(`(?:^|;\\s*)umbrella_consent=\\w+\\.${consentEpoch}(?:;|$)`).test(req.headers.cookie ?? "");
}

function record(site, jobId, params) {
  const check = { at: new Date().toISOString(), ...checkSubmission(site, jobId, params) };
  submissions[site].push(check);
  const status = check.fieldsCorrect ? "correct" : `missing=[${check.missing}] wrong=[${check.wrong.map((w) => w.field)}]`;
  console.log(`[bench-sites] ${site} submission #${submissions[site].length} job=${jobId} ${status}`);
  return check;
}

async function handle(req, res, base) {
  const u = new URL(req.url, base);
  const path = u.pathname.replace(/\/+$/, "") || "/";

  if (path === "/__results" && req.method === "GET") return json(res, 200, results(base));
  if (path === "/__reset" && req.method === "POST") {
    for (const list of Object.values(submissions)) list.length = 0;
    consentEpoch = Date.now().toString(36);
    return json(res, 200, { ok: true });
  }
  if (path === "/") {
    const links = Object.entries(SITES).map(([k, s]) => `<li><a href="/${k}">${esc(s.name)}</a></li>`).join("");
    return send(res, 200, `<!doctype html><title>Practice careers sites</title><h1>Practice careers sites</h1><ul>${links}</ul>`);
  }

  const [, site, section, jobId, action] = path.split("/");
  const s = SITES[site];
  if (!s) return send(res, 404, "Not found", "text/plain");
  const overlay = site === "umbrella" && !hasConsent(req);

  if (site === "hooli" && section === "api" && jobId === "cities") {
    const q = (u.searchParams.get("q") ?? "").trim().toLowerCase();
    return json(res, 200, q.length < 2 ? [] : CITIES.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 6));
  }
  if (!section) return send(res, 200, page(site, "Open positions", listing(site), { overlay }));
  if (section !== "jobs") return send(res, 404, page(site, "Not found", "<h1>Page not found</h1>"));

  const job = JOBS.find((j) => s.ids[j.key] === jobId);
  if (!job) return send(res, 404, page(site, "Not found", "<h1>Job not found</h1>"));
  if (!action && req.method === "GET") return send(res, 200, page(site, job.title, detail(site, job), { overlay }));

  const applyPath = `/${site}/jobs/${jobId}/apply`;
  if (action === "apply" && req.method === "GET") {
    const built = { acme: acmeForm, globex: globexForm, initech: initechForm, umbrella: umbrellaForm, hooli: hooliForm }[site](applyPath, job);
    const { body, script } = typeof built === "string" ? { body: built, script: "" } : built;
    return send(res, 200, page(site, `Apply: ${job.title}`, body, { script, overlay }));
  }
  if (action === "apply" && req.method === "POST") {
    const params = new URLSearchParams(await readBody(req));
    if (site === "umbrella") {
      return send(res, 200, page(site, "Review application", umbrellaConfirm(`/${site}/jobs/${jobId}/confirm`, applyPath, params), { overlay }));
    }
    record(site, jobId, params);
    return send(res, 200, page(site, "Application received", thanks(site)));
  }
  if (site === "umbrella" && action === "confirm" && req.method === "POST") {
    record(site, jobId, new URLSearchParams(await readBody(req)));
    return send(res, 200, page(site, "Application received", thanks(site)));
  }
  return send(res, 404, page(site, "Not found", "<h1>Page not found</h1>"));
}

export function startSites(port = 4777, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const base = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
    const server = http.createServer((req, res) => {
      handle(req, res, base).catch((error) => {
        console.error("[bench-sites]", error);
        if (!res.headersSent) send(res, 500, String(error?.message ?? error), "text/plain");
      });
    });
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, base }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const i = process.argv.indexOf("--port");
  const port = i > 0 ? Number(process.argv[i + 1]) : 4777;
  const { base } = await startSites(port);
  console.log(`[bench-sites] listening on ${base} (${Object.keys(SITES).map((k) => `/${k}`).join(" ")})`);
}
