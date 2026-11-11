// In-memory substitute for the @forge/kvs Custom Entity Store calls the app makes, with the
// indexes declared in manifest.yml: partition matches, newest-first range order, limits and
// cursors. `failing` makes every call throw, as an outage does;
// `failNext(call)` makes the next such call fail once.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const manifest = parse(readFileSync(new URL('../../manifest.yml', import.meta.url), 'utf8'));
const indexes = Object.fromEntries(
  manifest.app.storage.entities.map((e) => [
    e.name,
    Object.fromEntries(e.indexes.map((i) => [i.name, i])),
  ]),
);

export function memoryEntities({ failing = false } = {}) {
  const data = new Map();
  const calls = [];
  const planned = [];
  const guard = (name) => {
    calls.push(name);
    if (failing) throw Error('private storage failure');
    const index = planned.indexOf(name);
    if (index >= 0) {
      planned.splice(index, 1);
      throw Error('private storage failure');
    }
  };
  const stored = (entity) => {
    if (!data.has(entity)) data.set(entity, new Map());
    return data.get(entity);
  };
  const entity = (name) => {
    if (!indexes[name]) throw Error(`Undeclared entity ${name}`);
    return {
      async set(key, value) {
        guard('set');
        stored(name).set(key, structuredClone(value));
      },
      async get(key) {
        guard('get');
        return structuredClone(stored(name).get(key));
      },
      async delete(key) {
        guard('delete');
        stored(name).delete(key);
      },
      query: () => ({
        index(indexName, options) {
          const index = indexes[name][indexName];
          if (!index) throw Error(`Undeclared index ${indexName}`);
          const partition = options?.partition ?? [];
          if (partition.length !== (index.partition ?? []).length)
            throw Error('Partition does not match the index');
          const q = { sort: 'ASC', limit: 10, cursor: 0 };
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
              q.cursor = Number(cursor);
              return builder;
            },
            async getMany() {
              guard('query');
              const [range] = index.range;
              const matching = [...stored(name)]
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
              return {
                results: page.map(([key, value]) => ({ key, value: structuredClone(value) })),
                ...(next < matching.length ? { nextCursor: String(next) } : {}),
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
    failNext: (name) => planned.push(name),
    values: (name = 'label-change') => [...stored(name).values()],
    keys: (name = 'label-change') => [...stored(name).keys()],
  };
}
