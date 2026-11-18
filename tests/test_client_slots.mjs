// The sidebar entry is registered while the client bundle loads, so a rejected
// slot shape used to blank the whole sidebar. This pins the behaviour against
// every shape the known DSH builds use: `id`, `key` only, both rejected, and a
// host with no slots at all.
//
// Run with: node tests/test_client_slots.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

const fakeReact = {
  createElement: () => null,
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
};

/** Evaluate the client bundle in a sandbox and hand back its module. */
function loadClient(warn = () => {}) {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { captured = definition; } } },
    console: { warn, log: () => {}, error: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'lib/client.js' });
  assert.ok(captured?.factory, 'the client bundle did not register a factory');
  return captured.factory((id) => {
    if (id === 'react') return fakeReact;
    throw new Error(`unexpected require: ${id}`);
  });
}

/** apply() with a slot registry; `register` decides which shapes are accepted. */
function applyWith(register, warn) {
  const mod = loadClient(warn);
  const registered = [];
  const slots = {
    inject: (slot, factory) => factory(),
    register: (entry, component) => {
      if (register) register(entry);
      registered.push({ entry, component });
      return { dispose() {} };
    },
  };
  mod.apply({ slots });
  return registered;
}

// 1. A build that takes `id`: one entry, named the way the list slot expects.
let rows = applyWith(null);
assert.equal(rows.length, 1, 'expected exactly one registration');
assert.equal(JSON.stringify(rows[0].entry),
  JSON.stringify({ name: 'sidebar.footer.action', id: 'dsh-pku-cluster' }));
assert.equal(typeof rows[0].component, 'function');
console.log('id build              ok');

// 2. A build that rejects `id` but knows `key`: the fallback has to land.
rows = applyWith((entry) => { if ('id' in entry) throw new Error('unknown option: id'); });
assert.equal(rows.length, 1);
assert.equal(JSON.stringify(rows[0].entry),
  JSON.stringify({ name: 'sidebar.footer.action', key: 'dsh-pku-cluster' }));
console.log('key-only build        ok');

// 3. A build that rejects every shape: warn, do not throw out of apply().
let warned = null;
assert.doesNotThrow(() => {
  applyWith(() => { throw new Error('unknown option'); }, (...args) => { warned = args; });
});
assert.ok(warned, 'a rejected registration should be reported through console.warn');
assert.match(String(warned.join(' ')), /sidebar registration failed/);
console.log('rejecting build       ok (warned, no throw)');

// 4. A host without slots (or an old one): apply() must be a no-op.
assert.doesNotThrow(() => loadClient().apply({}));
assert.doesNotThrow(() => loadClient().apply({ slots: {} }));
console.log('host without slots    ok (no throw)');
