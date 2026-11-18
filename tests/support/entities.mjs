// In-memory substitute for the @forge/kvs Custom Entity Store calls the app makes, with the
// indexes declared in manifest.yml: partition matches, newest-first range order, limits and
// cursors. A cursor is refused with parameters other than its query's, as Forge documents.
//
// Faults: `failing` makes every call throw, as an outage does; `failNext(call, entity?)` makes the
// next such call fail once; `failWhen(fn)` fails every call `fn({ call, entity, key })` picks until
// `failWhen()` clears it. `setRaw(key, value)` stores under any key.
//
// Consistency: `get` reads the latest value, as Forge's `get` does. Queries are eventually
// consistent in Forge; `lag: n` makes them see the store as it was n writes ago, so a job that
// re-queries straight after writing meets the stale rows a real index can return.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const manifest = parse(readFileSync(new URL('../../manifest.yml', import.meta.url), 'utf8'));
const indexes = Object.fromEntries(
  manifest.app.storage.entities.map((e) => [
    e.name,
    Object.fromEntries(e.indexes.map((i) => [i.name, i])),
  ]),
);

export function memoryEntities({ failing = false, lag = 0 } = {}) {
  const data = new Map();
  // What queries see: `data` as it was `lag` writes ago.
  const indexed = new Map();
  const writes = [];
  const calls = [];
  const planned = [];
  let failWhen;
  // Each cursor handed out, with the query parameters it belongs to.
  const cursors = new Map();
  const guard = (call, entity, key) => {
    calls.push(call);
    if (failing || failWhen?.({ call, entity, key })) throw Error('private storage failure');
    const index = planned.findIndex((p) => p.call === call && (!p.entity || p.entity === entity));
    if (index >= 0) {
      planned.splice(index, 1);
      throw Error('private storage failure');
    }
  };
  const table = (map, entity) => {
    if (!map.has(entity)) map.set(entity, new Map());
    return map.get(entity);
  };
  const settle = (keep) => {
    while (writes.length > keep) {
      const { entity, key, value } = writes.shift();
      if (value === undefined) table(indexed, entity).delete(key);
      else table(indexed, entity).set(key, value);
    }
  };
  const write = (entity, key, value) => {
    if (value === undefined) table(data, entity).delete(key);
    else table(data, entity).set(key, structuredClone(value));
    writes.push({ entity, key, value: value === undefined ? undefined : structuredClone(value) });
    settle(lag);
  };
  const entity = (name) => {
    if (!indexes[name]) throw Error(`Undeclared entity ${name}`);
    return {
      async set(key, value) {
        guard('set', name, key);
        write(name, key, value);
      },
      async get(key) {
        guard('get', name, key);
        return structuredClone(table(data, name).get(key));
      },
      async delete(key) {
        guard('delete', name, key);
        write(name, key, undefined);
      },
      query: () => ({
        index(indexName, options) {
          const index = indexes[name][indexName];
          if (!index) throw Error(`Undeclared index ${indexName}`);
          const partition = options?.partition ?? [];
          if (partition.length !== (index.partition ?? []).length)
            throw Error('Partition does not match the index');
          const q = { sort: 'ASC', limit: 10, cursor: 0, token: undefined };
          const builder = {
            sort(sort) {
              q.sort = sort;
              return builder;
            },
            limit(limit) {
              if (limit < 1 || limit > 100) throw Error('Limit out of range');
              q.limit = limit;
              return builder;
            },
            cursor(cursor) {
              q.token = cursor;
              return builder;
            },
            async getMany() {
              guard('query', name);
              const params = JSON.stringify([name, indexName, partition, q.sort, q.limit]);
              if (q.token !== undefined) {
                const issued = cursors.get(q.token);
                if (!issued || issued.params !== params)
                  throw Error('Cursor used with different query parameters');
                q.cursor = issued.offset;
              }
              const [range] = index.range;
              const matching = [...table(indexed, name)]
                .filter(([, value]) =>
                  (index.partition ?? []).every((field, i) => value[field] === partition[i]),
                )
                .filter(([, value]) => value[range] !== undefined)
                .sort(([ka, a], [kb, b]) =>
                  a[range] === b[range] ? (ka < kb ? -1 : 1) : a[range] < b[range] ? -1 : 1,
                );
              if (q.sort === 'DESC') matching.reverse();
              const page = matching.slice(q.cursor, q.cursor + q.limit);
              const next = q.cursor + q.limit;
              const token = `c${cursors.size + 1}`;
              if (next < matching.length) cursors.set(token, { params, offset: next });
              return {
                results: page.map(([key, value]) => ({ key, value: structuredClone(value) })),
                ...(next < matching.length ? { nextCursor: token } : {}),
              };
            },
          };
          return builder;
        },
      }),
    };
  };
  return {
    kvs: { entity },
    Sort: { ASC: 'ASC', DESC: 'DESC' },
    calls,
    failNext: (call, name) => planned.push({ call, entity: name }),
    failWhen: (fn) => {
      failWhen = fn;
    },
    /** Lets the index catch up with every write, as it does given time. */
    settle: () => settle(0),
    setRaw: (key, value, name = 'label-change') => write(name, key, value),
    values: (name = 'label-change') => [...table(data, name).values()],
    keys: (name = 'label-change') => [...table(data, name).keys()],
  };
}
