// ============================================================================
// SandTogether — co-op multiplayer mod for Sandustry
// Shared bundle.js patch engine: patch.js (and so install.js / install.ps1)
// and the st-main.js auto-updater all apply patches.json through this file,
// so they pick the same variants. No dependencies.
// ============================================================================
'use strict';
const fs = require('fs');
const vm = require('vm');

// First line of a patched bundle: which hooks applied. The renderer reads it as SandTogether._hooks.
const MANIFEST_TAG = '/*ST_HOOKS*/';

// FH module alias of this build. Steam can serve re-minified builds of one version ("se.FH" vs "ie.FH").
// Works on an already patched bundle too (the vanilla emit(e,"frame:update" form is gone then).
function detectFhAlias(s) {
  const re = /([A-Za-z_$][A-Za-z0-9_$]{0,3})\.FH\.events\.emit\(/g;
  let m;
  while ((m = re.exec(s))) if (s.slice(m.index, m.index + 220).includes('"frame:update"')) return m[1];
  return null;
}

// --- wildcard matching -------------------------------------------------------
// Minified locals (2 chars or fewer, not a property or object key, not in a string) become captures
// with backreferences. Longer names, property names and strings stay literal.
const KEYWORDS = new Set(['if', 'do', 'in']);
const CAPTURE = '(?<![\\w$.])(?!(?:if|do|in|var|let|new|for|try)(?![\\w$]))([A-Za-z_$][\\w$]{0,2})(?![\\w$])';
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function tokens(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out.push({ v: src.slice(i, j + 1) });
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      const v = src.slice(i, j);
      const prop = (src[i - 1] === '.' && src[i - 2] !== '.') || ((src[i - 1] === '{' || src[i - 1] === ',') && src[j] === ':');
      const keyword = KEYWORDS.has(v) || (v === 'of' && src[i - 1] === ' ');
      out.push({ v, local: !prop && !keyword && v.length <= 2 });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$.]/.test(src[j])) j++;
      out.push({ v: src.slice(i, j) });
      i = j;
    } else { out.push({ v: c }); i++; }
  }
  return out;
}

// Regex for a text: every local is a capture, repeats are backreferences. Returns { re, locals[] }.
function toPattern(text) {
  const locals = [];
  let re = '';
  for (const t of tokens(text)) {
    if (!t.local) { re += esc(t.v); continue; }
    const k = locals.indexOf(t.v);
    if (k >= 0) re += '\\' + (k + 1);
    else { locals.push(t.v); re += CAPTURE; }
  }
  return { re: new RegExp(re, 'g'), locals };
}

// Wildcard plan for one variant, or { refuse } when `patched` uses locals the anchor doesn't bind:
// a match would prove nothing about them (the review caveat, e.g. `f` in the volcanizer hook).
function wildcardPlan(anchor, patched) {
  const a = toPattern(anchor);
  const unbound = [...new Set(tokens(patched).filter((t) => t.local && !a.locals.includes(t.v)).map((t) => t.v))];
  if (unbound.length) return { refuse: 'patched uses locals not in the anchor: ' + unbound.join(', ') };
  return a;
}

function matchesUpTo2(re, s) {
  re.lastIndex = 0;
  const hits = [];
  let m;
  while (hits.length < 2 && (m = re.exec(s))) { hits.push(m); if (m[0] === '') re.lastIndex++; }
  return hits;
}

// Try a variant with wildcards: { text, map } on a unique, consistent match, else { reason }.
function applyWildcard(s, v) {
  const plan = wildcardPlan(v.anchor, v.patched);
  if (plan.refuse) return { reason: plan.refuse };
  if (!plan.locals.length) return { reason: 'no locals to adapt' };
  const hits = matchesUpTo2(plan.re, s);
  if (!hits.length) return { reason: 'no match' };
  if (hits.length > 1) return { reason: 'ambiguous' };
  const m = hits[0];
  const map = {};
  plan.locals.forEach((name, k) => { map[name] = m[k + 1]; });
  // two different locals must not land on one name
  if (new Set(Object.values(map)).size !== plan.locals.length) return { reason: 'locals collapse onto one name' };
  const out = tokens(v.patched).map((t) => (t.local ? map[t.v] : t.v)).join('');
  return { text: s.slice(0, m.index) + out + s.slice(m.index + m[0].length), map };
}

// The variant as it reads in the new build (check-anchors.js --emit), for review before it goes into patches.json.
function adaptVariant(v, map) {
  const sub = (text) => tokens(text).map((t) => (t.local && map[t.v] ? map[t.v] : t.v)).join('');
  return { anchor: sub(v.anchor), patched: sub(v.patched), note: 'auto-adapted from: ' + (v.note || 'unnamed variant') };
}

function wildcardAlready(s, v) {
  const p = toPattern(v.patched);
  return p.locals.length > 0 && matchesUpTo2(p.re, s).length > 0;
}

// --- webpack registry ----------------------------------------------------------
// Patches can also declare "registry" uses (patches.json): module exports the renderer reads or wraps
// through the bundle's webpack registry (sandtogether.js, installRegistry). Modules are found by the
// export names they define, with known ids as hints, because ids move between builds (FH: 46781 -> 13125).

// Runs the bundle's webpack runtime in a vm only until it processes a chunk we queued, which hands
// over __webpack_require__ before any game module is instantiated.
function loadRegistry(src) {
  const STOP = new Error('ST_STOP');
  let req = null;
  const g = { location: { href: 'file:///st/dist/index.html' } };
  g.document = { currentScript: { tagName: 'SCRIPT', src: 'file:///st/dist/js/bundle.js' }, baseURI: 'file:///st/dist/', getElementsByTagName: () => [] };
  g.self = g; g.window = g;
  g.webpackChunksand_v1 = [[['st-probe'], {}, (r) => { req = r; throw STOP; }]];
  try { vm.runInNewContext(src, g, { filename: 'bundle.js', timeout: 15000 }); } catch (e) { if (e !== STOP) return { error: 'webpack runtime: ' + e.message }; }
  return req ? { req } : { error: 'webpack runtime not reached' };
}

// Export names a module factory defines: n.d(t,{name:()=>local,...}), sometimes in several calls.
function factoryExports(f) {
  const names = [], re = /\.d\([\w$]+,\{([^}]*)\}\)/g;
  let m;
  while ((m = re.exec(String(f)))) for (const p of m[1].split(',')) { const k = /^\s*["']?([\w$]+)["']?\s*:/.exec(p); if (k) names.push(k[1]); }
  return names;
}

// Calls of the local behind an export inside its own module. An export wrapper doesn't see them,
// so a wrapped export must have none (check-anchors reports it).
function innerCalls(f, name) {
  const s = String(f), m = new RegExp('[{,]\\s*' + esc(name) + ':\\(\\)=>([\\w$]+)[,}]').exec(s);
  if (!m) return null;
  return (s.match(new RegExp('(?<![\\w$.])(?<!function )' + esc(m[1]) + '\\(', 'g')) || []).length;
}

// Module id for one registry use: a hinted id that defines all named exports, else the only module that does.
function resolveUse(req, u, cache) {
  const need = [...u.exports, u.wrap || u.get || u.frame].filter(Boolean);
  const has = (id) => {
    if (!cache.has(id)) cache.set(id, typeof req.m[id] === 'function' ? factoryExports(req.m[id]) : []);
    return need.every((e) => cache.get(id).includes(e));
  };
  for (const id of u.m || []) if (has(String(id))) return { id: Number(id) };
  const hits = Object.keys(req.m).filter(has);
  if (hits.length === 1) return { id: Number(hits[0]) };
  return { error: hits.length ? 'ambiguous: modules ' + hits.slice(0, 4).join(',') : 'no module defines ' + need.join('+') };
}

// -> { entries: [{ id, full, use: [use + resolved m], errors: [] }] } or { error }
function resolveRegistry(src, defs) {
  const withReg = (defs.bundle || []).filter((p) => p.registry && Array.isArray(p.registry.use));
  if (!withReg.length) return { entries: [] };
  const L = loadRegistry(src);
  if (L.error) return { error: L.error, entries: [] };
  const cache = new Map();
  return {
    entries: withReg.map((p) => {
      const use = [], errors = [];
      for (const u of p.registry.use) {
        const r = resolveUse(L.req, u, cache);
        if (r.error) errors.push((u.wrap || u.get || u.frame || u.as) + ': ' + r.error);
        else {
          use.push(Object.assign({}, u, { m: r.id }));
          const n = u.wrap ? innerCalls(L.req.m[r.id], u.wrap) : 0;
          if (n) errors.push(u.wrap + ': called ' + n + 'x inside module ' + r.id + ', an export wrapper would miss those calls');
        }
      }
      return { id: p.id || p.name, full: !!p.registry.full, use, errors };
    }),
  };
}

// --- engine ------------------------------------------------------------------
const countUpTo2 = (s, needle) => { const i = s.indexOf(needle); return i < 0 ? 0 : (s.indexOf(needle, i + 1) < 0 ? 1 : 2); };
const parseError = (src) => { try { new vm.Script(src, { filename: 'bundle.js' }); return null; } catch (e) { return e.message; } };

// Applies defs.bundle to the bundle text. Per patch: first variant whose literal anchor is unique
// (also with the FH alias rewritten), then, if allowed, the newest variant with wildcards.
// A patch whose string form is missing but whose registry use fully resolves is left to the renderer.
// result.status: applied | already | wildcard | registry | missing.
// opts: wildcard (default true), skip (patch ids left to the registry, for testing), registry (default true)
function applyBundle(src, defs, opts) {
  const wildcard = !opts || opts.wildcard !== false;
  const skip = (opts && opts.skip) || [];
  // a bundle patched by this engine before (no pristine copy): its manifest says which hooks were adapted
  let prevWild = [];
  if (src.startsWith(MANIFEST_TAG)) try { prevWild = JSON.parse(/_hooks=(\{.*\})\);$/.exec(src.slice(0, src.indexOf('\n')))[1]).wild || []; } catch (e) { /* unreadable: treat as none */ }
  let s = src.startsWith(MANIFEST_TAG) ? src.slice(src.indexOf('\n') + 1) : src;
  const fhAlias = detectFhAlias(s);
  const adapt = (t) => (fhAlias && fhAlias !== 'ie') ? t.split('ie.FH').join(fhAlias + '.FH') : t;
  const results = [];
  for (const pt of defs.bundle || []) {
    const r = { id: pt.id || pt.name, name: pt.name, critical: !!pt.critical, status: 'missing' };
    results.push(r);
    const vs = pt.variants || [];
    if (skip.includes(r.id)) { r.reason = 'skipped'; continue; }
    for (let vi = 0; vi < vs.length && r.status === 'missing'; vi++) {
      const v = vs[vi];
      const pairs = fhAlias && fhAlias !== 'ie' ? [[v.anchor, v.patched], [adapt(v.anchor), adapt(v.patched)]] : [[v.anchor, v.patched]];
      for (const [anch, patched] of pairs) {
        if (s.includes(patched)) { r.status = 'already'; r.variant = vi; break; }
        const n = countUpTo2(s, anch);
        if (n === 2) r.ambiguous = (r.ambiguous || 0) + 1;
        if (n !== 1) continue;
        s = s.replace(anch, () => patched);
        r.status = 'applied'; r.variant = vi;
        break;
      }
    }
    // Wildcards adapt only the newest variant (the first): older ones describe older code and can
    // match an unrelated site of the same shape (measured: the oldest cryo variant on 0.6.0).
    if (r.status !== 'missing' || !wildcard || !vs.length) continue;
    if (prevWild.includes(r.id) && wildcardAlready(s, vs[0])) { r.status = 'already'; r.variant = 0; r.adapted = true; continue; }
    const w = applyWildcard(s, vs[0]);
    if (w.text) { s = w.text; r.status = 'wildcard'; r.variant = 0; r.map = w.map; }
    else r.reason = w.reason;
  }
  // a broken bundle must never be written: drop the wildcard patches first, then give up
  let error = null;
  if (s !== src && parseError(s) && !parseError(src)) {
    if (wildcard && results.some((r) => r.status === 'wildcard')) {
      const again = applyBundle(src, defs, Object.assign({}, opts, { wildcard: false }));
      again.wildcardDropped = true;
      return again;
    }
    error = 'patched bundle does not parse: ' + parseError(s);
  }
  // registry uses are resolved on the unpatched text: a patch may split a module's export list
  const reg = opts && opts.registry === false ? { entries: [] } : resolveRegistry(src.startsWith(MANIFEST_TAG) ? src.slice(src.indexOf('\n') + 1) : src, defs);
  const regUse = [];
  for (const e of reg.entries) {
    const r = results.find((x) => x.id === e.id);
    r.registry = e;
    if (e.full ? e.errors.length : !e.use.length) continue;
    if (r.status === 'missing' && e.full) r.status = 'registry';
    regUse.push({ id: e.id, s: r.status !== 'missing' && r.status !== 'registry', full: e.full, use: e.use });
  }
  const by = (f) => results.filter(f).map((r) => r.id);
  const manifest = {
    v: 1,
    ok: by((r) => r.status === 'applied' || (r.status === 'already' && !r.adapted)),
    wild: by((r) => r.status === 'wildcard' || r.adapted),
    miss: by((r) => r.status === 'missing'),
    reg: regUse,
  };
  const text = error ? null : MANIFEST_TAG + 'window.SandTogether&&(window.SandTogether._hooks=' + JSON.stringify(manifest) + ');\n' + s;
  return {
    text, error, results, fhAlias, manifest, registryError: reg.error || null,
    criticalFail: results.some((r) => r.critical && r.status === 'missing'),
    featureMiss: results.filter((r) => !r.critical && r.status === 'missing').length,
  };
}

// Start from the pristine bundle (kept as bundle.js.orig next to it), so patches.json only needs
// variants per GAME version. Without a pristine copy, an unpatched bundle becomes one.
function restorePristine(bundlePath) {
  const orig = bundlePath + '.orig';
  if (fs.existsSync(orig)) fs.copyFileSync(orig, bundlePath);
  else if (!fs.readFileSync(bundlePath, 'utf8').includes('window.SandTogether')) fs.copyFileSync(bundlePath, orig);
}

// File wrapper used by patch.js and the auto-updater. Writes only a bundle that parses.
function patchBundleFile(bundlePath, defs, opts) {
  try { restorePristine(bundlePath); } catch (e) { /* read-only copy: patch what is there */ }
  const src = fs.readFileSync(bundlePath, 'utf8');
  const res = applyBundle(src, defs, opts);
  res.written = !!res.text && res.text !== src;
  if (res.written) fs.writeFileSync(bundlePath, res.text, 'utf8');
  return res;
}

module.exports = { applyBundle, patchBundleFile, restorePristine, detectFhAlias, adaptVariant, tokens, toPattern, wildcardPlan, loadRegistry, factoryExports, innerCalls, resolveRegistry, MANIFEST_TAG };
