// App-owned popup harness: runs the real `src/app.tsx` on `@forge/react`'s own reconciler and host
// configuration, with a fake `@forge/bridge` whose resolvers each test supplies. It reads the UI Kit
// tree the reconciler hands to the host; it does not establish Confluence's rendering, layout or
// focus. It patches CommonJS resolution, which is safe because each test file runs in its own
// process.
import Public from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** @type {any} CommonJS loader internals (`_cache`, `_compile`, `_resolveFilename`), untyped. */
const Module = Public;
const src = fileURLToPath(new URL('../../src/', import.meta.url));
// Not from `src/`: Node caches resolutions per directory, and the app's own imports must resolve
// through the hook below.
const require = Module.createRequire(import.meta.url);

let handlers = {};
/** Every resolver call of the open popup, in order: `{ name, payload }`. */
let calls = [];
let context;
let root;
let tree;
let container;

// UI Kit's renderer sends each committed tree to the host through this global bridge.
/** @type {any} */ (globalThis).self = globalThis;
/** @type {any} */ (globalThis).__bridge = {
  callBridge(command, data) {
    if (command === 'reconcile' && data.forgeDoc === root) tree = data.forgeDoc;
    return Promise.resolve();
  },
};
const bridge = {
  invoke(name, payload) {
    calls.push({ name, payload });
    return Promise.resolve().then(() => handlers[name](payload));
  },
  view: { getContext: () => Promise.resolve(context) },
};

const virtual = (name, exports) => {
  const filename = `${src}${name}.popup-harness.cjs`;
  Module._cache[filename] = Object.assign(new Module(filename), {
    filename,
    loaded: true,
    exports,
  });
  return filename;
};
const ids = { '@forge/bridge': virtual('@forge/bridge', bridge) };
function compile(file) {
  const filename = `${src}${file}.popup-harness.cjs`;
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(src);
  Module._cache[filename] = module;
  const { outputText } = ts.transpileModule(readFileSync(join(src, file), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  });
  module._compile(outputText, filename);
  module.loaded = true;
  return filename;
}
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@forge/bridge') return ids[request];
  if (parent?.filename?.startsWith(src) && parent.filename.endsWith('.popup-harness.cjs')) {
    if (request === '@forge/react') return (ids[request] ??= virtual(request, wrapped));
    if (request === './client') return (ids[request] ??= compile('client.ts'));
  }
  return resolve.call(this, request, parent, ...rest);
};

// Loaded after the fake bridge is in place, so UI Kit's hooks read the test's context.
const forgeReact = require.resolve('@forge/react');
// The package exports only its index; the host configuration is the module that index renders with.
const { hostConfig, createElement } = require(join(dirname(forgeReact), 'reconciler.js'));
const reconciler = Module.createRequire(forgeReact)('react-reconciler')(hostConfig);
// The app's module calls `ForgeReconciler.render` once when it loads; the harness keeps the element
// and renders it into a fresh root for each popup.
let app;
const wrapped = {
  __esModule: true,
  ...require('@forge/react'),
  default: {
    render: (element) => {
      app = element;
    },
  },
};
compile('app.tsx');

/** Waits until the popup's pending promises and renders are done. */
export async function settle() {
  for (let i = 0; i < 20; i++) await new Promise(setImmediate);
}

/** Closes the open popup: its effects clean up, and its late answers render nothing. */
export async function close() {
  if (container) reconciler.updateContainer(null, container, null, null);
  container = undefined;
  await settle();
}

/**
 * Opens the popup on page 1001 for viewer-1, answering resolver calls with `resolvers` (name to
 * function of the payload). `extension` replaces the byline's context.
 */
export async function open(resolvers, extension = { content: { id: '1001', type: 'page' } }) {
  await close();
  handlers = resolvers;
  calls = [];
  tree = undefined;
  context = { accountId: 'viewer-1', locale: 'en-US', timezone: 'UTC', extension };
  root = createElement({ type: 'Root', props: {}, forgeReactMajorVersion: 11 });
  container = reconciler.createContainer(root, 0, null, false, null, 'root', () => {}, null);
  reconciler.updateContainer(app, container, null, null);
  await settle();
}

const walk = (node, visit) => {
  if (!node) return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};
/** Rendered elements of a UI Kit type. */
function all(type) {
  const found = [];
  walk(tree, (node) => node.type === type && found.push(node));
  return found;
}
/** An element's text; a User shows as its account ID. */
export function text(node = tree) {
  const parts = [];
  walk(node, (n) => {
    if (n.type === 'String') parts.push(n.props.text);
    if (n.type === 'User') parts.push(n.props.accountId);
  });
  return parts.join('');
}
/** The table's rows, each as its cells' text. */
export const rows = () => all('Row').map((row) => row.children.map((cell) => text(cell)));
/** Section messages as `[appearance, title]`. */
export const messages = () => all('SectionMessage').map((m) => [m.props.appearance, m.props.title]);
/** The buttons whose text is `label`. */
export const buttons = (label) =>
  [...all('Button'), ...all('LoadingButton')].filter((b) => text(b) === label);
/** Clicks the nth enabled button whose text is `label`, then waits for the renders. */
export async function click(label, index = 0) {
  const button = buttons(label)[index];
  if (!button || button.props.isDisabled) throw Error(`No enabled button: ${label}`);
  button.props.onClick();
  await settle();
}
/** How many times a resolver was called. */
export const count = (name) => calls.filter((c) => c.name === name).length;
