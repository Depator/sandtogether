// A minimal browser-like global for running sandtogether.js and the game's bundle in a vm.
// JS builtins come from the vm context itself; the few browser objects touched at load time
// are "universal stubs": callable, constructible, every property is another stub.
'use strict';
const vm = require('vm');

function stub(name) {
  const props = {};
  const fn = function () { return stub(name + '()'); };
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return (hint) => (hint === 'number' ? 0 : '');
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;
      if (k === 'prototype' || k === 'length' || k === 'call' || k === 'apply' || k === 'bind') return t[k];
      if (!(k in props)) props[k] = stub(name + '.' + String(k));
      return props[k];
    },
    set(t, k, v) { props[k] = v; return true; },
    construct() { return stub('new ' + name); },
  });
}

module.exports = function makeContext() {
  const logs = [];
  const g = {
    console: { log: (...a) => logs.push(a.map(String).join(' ')), warn() {}, error: (...a) => logs.push('ERR ' + a.map(String).join(' ')), info() {}, debug() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, queueMicrotask: (f) => Promise.resolve().then(f),
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    performance: { now: () => Date.now() },
    location: { href: 'file:///st/dist/index.html', search: '', hash: '' },
    navigator: { language: 'en', userAgent: 'vm', hardwareConcurrency: 4 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    TextEncoder, TextDecoder, URL, atob, btoa, structuredClone,
    Worker: class Worker { postMessage() {} addEventListener() {} removeEventListener() {} terminate() {} get onmessage() { return null; } set onmessage(v) {} },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  };
  g.document = new Proxy({
    readyState: 'loading', currentScript: { tagName: 'SCRIPT', src: 'file:///st/dist/js/bundle.js' }, baseURI: 'file:///st/dist/',
    addEventListener() {}, getElementsByTagName: () => [], querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    createElement: () => stub('element'), createElementNS: () => stub('element'), body: stub('body'), head: stub('head'), documentElement: stub('html'),
  }, { get(t, k) { return k in t ? t[k] : stub('document.' + String(k)); } });
  g.self = g; g.window = g;
  return { ctx: vm.createContext(g), g, logs };
};
