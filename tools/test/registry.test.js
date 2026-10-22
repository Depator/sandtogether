// Webpack registry hooks against the real game bundles: sandtogether.js and the patched bundle run in
// one vm, the bundle's webpack runtime processes the queued chunk (installRegistry), then the target
// modules are instantiated by hand and their exports called with spies. No game loop, no DOM.
// Needs ST_GAME_VERSIONS=<dir of <version>/app builds>. Run: node --test "tools/test/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const engine = require('../../src/st-patch-engine.js');
const makeContext = require('./vm-env.js');

const ROOT = path.join(__dirname, '../..');
const defs = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/patches.json'), 'utf8'));
const MOD = fs.readFileSync(path.join(ROOT, 'src/sandtogether.js'), 'utf8');
const FALLBACK = ['frame', 'dig', 'drone', 'grab', 'projCtx', 'dropLu', 'demolExports', 'techMod'];
const builds = process.env.ST_GAME_VERSIONS;
const versions = builds ? fs.readdirSync(builds).filter((v) => fs.existsSync(path.join(builds, v, 'app/dist/js/bundle.js'))) : [];

// sandtogether.js + patched bundle in one context; returns { ST, req, at(id) -> module id of a registry use }
function boot(ver, skip) {
  const pristine = fs.readFileSync(path.join(builds, ver, 'app/dist/js/bundle.js'), 'utf8');
  const res = engine.applyBundle(pristine, defs, { skip });
  assert.strictEqual(res.error, null);
  const { ctx, g } = makeContext();
  vm.runInContext(MOD, ctx, { filename: 'sandtogether.js' });
  let req = null;
  const STOP = new Error('STOP');
  g.webpackChunksand_v1.push([['harness'], {}, (r) => { req = r; throw STOP; }]); // after the mod's chunk
  try { vm.runInContext(res.text, ctx, { filename: 'bundle.js' }); } catch (e) { if (e !== STOP) throw e; }
  const ST = g.SandTogether;
  const at = (id, name) => ST._hooks.reg.find((r) => r.id === id).use.find((u) => (u.wrap || u.get || u.frame || '*') === name).m;
  return { ST, req, at };
}
const spy = (ret) => { const f = function (...a) { f.calls.push(a); return ret; }; f.calls = []; return f; };

for (const ver of versions.length ? versions : ['(none)']) {
  test(ver + ': registry hooks stand in for the string patches', { skip: !builds && 'set ST_GAME_VERSIONS' }, () => {
    const { ST, req, at } = boot(ver, FALLBACK);
    // instantiating these pulls in most of the game API, as the real entry would
    for (const r of ST._hooks.reg) for (const u of r.use) req(u.m);
    assert.deepStrictEqual([...ST._hooks.rtErr], []); // vm-realm array: spread before comparing
    assert.deepStrictEqual([...ST._hooks.rt].sort(), [...FALLBACK].sort());

    const state = { store: { drones: [], projectiles: [] } };
    assert.strictEqual(typeof req(at('dig', 'DN')).DN.__stOrig, 'function'); // the export is our wrapper
    ST._dig = spy(true);
    assert.strictEqual(req(at('dig', 'DN')).DN(state, 1, 2, [[1]], 0, 5), undefined);
    assert.deepStrictEqual(ST._dig.calls, [[state, 1, 2, [[1]], 0, 5]]);

    const FH = req(at('frame', 'FH')).FH;
    ST._frame = spy();
    try { FH.events.emit(state, 'frame:update', { state, dt: 1 }); } catch (e) { /* the game's listeners need a real state */ }
    assert.deepStrictEqual(ST._frame.calls, [[state, FH]]);
    try { FH.events.emit(state, 'some:other', {}); } catch (e) { /* same */ }
    assert.strictEqual(ST._frame.calls.length, 1);

    ST._drone = spy();
    const drone = { id: 7 };
    req(at('drone', '_z'))._z(state, drone);
    assert.deepStrictEqual(ST._drone.calls, [[state, drone]]);
    assert.deepStrictEqual(state.store.drones, [drone]);

    let inside = null;
    req(at('projCtx', 'Ul')).Ul({ store: { projectiles: { forEach() { inside = ST._projCtx; } } } }, 1);
    assert.strictEqual(inside, 1);
    assert.strictEqual(ST._projCtx, 0);

    ST._grab = spy(true);
    assert.strictEqual(req(at('grab', 'wK')).wK(state, { data: null }), undefined); // the original would throw on data null
    assert.strictEqual(ST._grab.calls.length, 1);

    ST._dropLu = spy(true);
    const lu = req(at('dropLu', 'Lu'));
    lu.Lu(state, 1, 2, () => {}); lu.f6(() => {});
    assert.strictEqual(ST._dropLu.calls.length, 2);

    // value leaks
    assert.strictEqual(ST._pipeZn, req(at('demolExports', 'Zn')).Zn);
    assert.strictEqual(ST._areaL, req(at('demolExports', 'Cj')).Cj);
    assert.strictEqual(ST._techMod, req(at('techMod', '*')));
    assert.strictEqual(typeof ST._techMod.BRANCH_PARENTS, 'object');
  });

  test(ver + ': with the string patches in place the registry only reads values', { skip: !builds && 'set ST_GAME_VERSIONS' }, () => {
    const { ST, req, at } = boot(ver, []);
    req(at('dig', 'DN')); req(at('frame', 'FH')); req(at('bpBulk', 'gJ')); req(at('projSprite', 'P9'));
    assert.deepStrictEqual([...ST._hooks.rtErr], []); // vm-realm array: spread before comparing
    assert.deepStrictEqual([...ST._hooks.rt].sort(), ['demolExports', 'techMod']);
    // the string-patched function calls the hook itself: exactly once, no second call from a wrapper
    assert.strictEqual(req(at('dig', 'DN')).DN.__stOrig, undefined); // the game's own export
    ST._dig = spy(true);
    req(at('dig', 'DN')).DN({}, 1, 2, [[1]], 0, 5);
    assert.strictEqual(ST._dig.calls.length, 1);
    assert.strictEqual(ST._drawStruct, req(at('bpBulk', 'gJ')).gJ);
    assert.strictEqual(ST._sprAdd, req(at('projSprite', 'P9')).P9);
  });
}
