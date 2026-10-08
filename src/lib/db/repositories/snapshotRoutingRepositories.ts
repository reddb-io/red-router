import { randomUUID } from "node:crypto";
import type {
  ComboRecord,
  ComboRepository,
  ModelComboMapping,
  ModelComboMappingRepository,
} from "@/domain/persistence/comboRepositories";
import { normalizeComboRecord } from "@/lib/combos/steps";
import { validateComboInvariant } from "@/lib/combos/invariants";
import { globToRegex } from "@/shared/utils/globPattern";
import { RoutingStorageError } from "./routingStorageConfig";
import {
  RoutingSnapshotStore,
  type RoutingSnapshot,
  type StoredCombo,
  type StoredMapping,
} from "./routingSnapshotStore";

const asciiFold = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const names = (state: RoutingSnapshot) => state.combos.map((row) => row.name.trim());
const orderedCombos = (state: RoutingSnapshot) =>
  [...state.combos].sort(
    (a, b) => a.sortOrder - b.sortOrder || compareText(asciiFold(a.name), asciiFold(b.name))
  );
const orderedMappings = (state: RoutingSnapshot) =>
  [...state.mappings].sort(
    (a, b) => b.priority - a.priority || compareText(a.createdAt, b.createdAt)
  );

function parseCombo(row: StoredCombo | undefined): ComboRecord | null {
  if (!row?.data) return null;
  try {
    const value: unknown = JSON.parse(row.data);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const combo: ComboRecord = { ...value, id: row.id, sortOrder: row.sortOrder };
    if (row.contextCacheProtection === 1) combo.context_cache_protection = true;
    return combo;
  } catch {
    return null;
  }
}

function normalized(combo: ComboRecord, state: RoutingSnapshot, extra: string[] = []): ComboRecord {
  return normalizeComboRecord(combo, { allCombos: [...names(state), ...extra] }) as ComboRecord;
}

function page<T>(items: T[], limit?: number, offset = 0): T[] {
  if (limit === undefined) return items;
  if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("Invalid routing pagination");
  }
  return items.slice(offset, offset + limit);
}

function listCombos(state: RoutingSnapshot, limit?: number, offset?: number): ComboRecord[] {
  const combos = page(orderedCombos(state), limit, offset)
    .map(parseCombo)
    .filter((row): row is ComboRecord => row !== null);
  const comboNames = combos
    .map((row) => (typeof row.name === "string" ? row.name.trim() : ""))
    .filter(Boolean);
  return combos.map((row) => normalizeComboRecord(row, { allCombos: comboNames }) as ComboRecord);
}

function nextSortOrder(state: RoutingSnapshot): number {
  return Math.max(0, ...state.combos.map((row) => row.sortOrder)) + 1;
}

function checkName(state: RoutingSnapshot, name: string, exceptId?: string): void {
  if (state.pendingCleanup.some((entry) => entry.name === name)) {
    throw new RoutingStorageError("conflict");
  }
  if (state.combos.some((row) => row.id !== exceptId && row.name === name)) {
    throw new RoutingStorageError("already_exists");
  }
}

function mappingRecord(row: StoredMapping, state: RoutingSnapshot): ModelComboMapping {
  return {
    ...row,
    comboName: state.combos.find((combo) => combo.id === row.comboId)?.name || undefined,
  };
}

function requireCombo(state: RoutingSnapshot, id: string): void {
  if (!state.combos.some((row) => row.id === id)) throw new TypeError("Unknown combo");
}

export function createSnapshotRoutingRepositories(store: RoutingSnapshotStore): {
  combos: ComboRepository;
  modelComboMappings: ModelComboMappingRepository;
} {
  const find = async (match: (row: StoredCombo) => boolean): Promise<ComboRecord | null> => {
    const state = await store.read();
    const combo = parseCombo(state.combos.find(match));
    return combo ? normalized(combo, state) : null;
  };

  const combos: ComboRepository = {
    list: async (limit, offset) => listCombos(await store.read(), limit, offset),
    count: async () => (await store.read()).combos.length,
    findById: (id) => find((row) => row.id === id),
    findByName: (name) => find((row) => row.name === name),
    findByNameInsensitive: (name) => find((row) => asciiFold(row.name) === asciiFold(name)),
    async create(data) {
      const id = typeof data.id === "string" && data.id.trim() ? data.id : randomUUID();
      const now = new Date().toISOString();
      return store.mutate((state) => {
        const name = typeof data.name === "string" ? data.name : "";
        if (!name.trim()) throw new TypeError("Combo name must be non-empty");
        if (state.pendingCleanup.some((entry) => entry.id === id || entry.name === name)) {
          throw new RoutingStorageError("conflict");
        }
        checkName(state, name);
        if (state.combos.some((row) => row.id === id))
          throw new RoutingStorageError("already_exists");
        const sortOrder =
          typeof data.sortOrder === "number" ? data.sortOrder : nextSortOrder(state);
        const combo = normalized(
          {
            ...data,
            id,
            name,
            models: data.models || [],
            strategy: data.strategy || "priority",
            config: data.config || {},
            isHidden: Boolean(data.isHidden),
            sortOrder,
            createdAt: now,
            updatedAt: now,
          },
          state,
          [name]
        );
        validateComboInvariant(combo);
        state.combos.push({
          id,
          name,
          data: JSON.stringify(combo),
          sortOrder,
          contextCacheProtection: data.context_cache_protection ? 1 : 0,
        });
        return { result: combo, changed: true };
      });
    },
    async update(id, data) {
      const now = new Date().toISOString();
      return store.mutate((state) => {
        const row = state.combos.find((item) => item.id === id);
        const current = parseCombo(row);
        if (!row || !current) return { result: null, changed: false };
        const sortOrder = typeof data.sortOrder === "number" ? data.sortOrder : row.sortOrder;
        const merged: ComboRecord = { ...current, ...data, sortOrder, updatedAt: now };
        for (const key of Object.keys(data)) if (data[key] === null) delete merged[key];
        const previousName = typeof current.name === "string" ? current.name : row.name;
        const currentName =
          typeof merged.name === "string" && merged.name.trim() ? merged.name : previousName;
        checkName(state, currentName, id);
        const combo = normalized({ ...merged, id, name: currentName }, state, [currentName]);
        validateComboInvariant({ ...combo, ...data, id, name: currentName, models: combo.models });
        Object.assign(row, {
          name: currentName,
          data: JSON.stringify(combo),
          sortOrder,
          contextCacheProtection: combo.context_cache_protection ? 1 : 0,
        });
        return {
          result: {
            combo,
            previousName,
            currentName,
            modelsFieldProvided: data.models !== undefined,
          },
          changed: true,
        };
      });
    },
    async reorder(ids) {
      const now = new Date().toISOString();
      return store.mutate((state) => {
        const rows = orderedCombos(state);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const requested = [...new Set(ids)].filter((id) => byId.has(id));
        const seen = new Set(requested);
        const order = [...requested, ...rows.map((row) => row.id).filter((id) => !seen.has(id))];
        order.forEach((id, index) => {
          const row = byId.get(id)!;
          const current = parseCombo(row);
          if (!current) return;
          const sortOrder = index + 1;
          const combo = normalized({ ...current, sortOrder, updatedAt: now }, state);
          Object.assign(row, { sortOrder, data: JSON.stringify(combo) });
        });
        return {
          result: { combos: listCombos(state), rowsReordered: order.length },
          changed: order.length > 0,
        };
      });
    },
    deleteById: (id) =>
      store.mutate((state) => {
        const row = state.combos.find((item) => item.id === id);
        const count = state.combos.length;
        state.combos = state.combos.filter((row) => row.id !== id);
        const deleted = state.combos.length !== count;
        if (deleted) {
          state.mappings = state.mappings.filter((row) => row.comboId !== id);
          state.pendingCleanup.push({ token: randomUUID(), id, name: row?.name || "" });
        }
        return { result: deleted, changed: deleted };
      }),
  };

  const modelComboMappings: ModelComboMappingRepository = {
    async list(options) {
      const state = await store.read();
      return {
        total: state.mappings.length,
        items: page(orderedMappings(state), options?.limit, options?.offset).map((row) =>
          mappingRecord(row, state)
        ),
      };
    },
    async findById(id) {
      const state = await store.read();
      const row = state.mappings.find((item) => item.id === id);
      return row ? mappingRecord(row, state) : null;
    },
    async create(data) {
      const id = randomUUID();
      const now = new Date().toISOString();
      return store.mutate((state) => {
        requireCombo(state, data.comboId);
        const mapping: StoredMapping = {
          id,
          pattern: data.pattern,
          comboId: data.comboId,
          priority: data.priority ?? 0,
          enabled: data.enabled !== false,
          description: data.description || "",
          createdAt: now,
          updatedAt: now,
        };
        state.mappings.push(mapping);
        // Preserve the create facade's existing shape; joined names appear on reads.
        return { result: mapping, changed: true };
      });
    },
    async update(id, data) {
      const now = new Date().toISOString();
      return store.mutate((state) => {
        const row = state.mappings.find((item) => item.id === id);
        if (!row) return { result: null, changed: false };
        const comboId = data.comboId ?? row.comboId;
        requireCombo(state, comboId);
        Object.assign(row, {
          pattern: data.pattern ?? row.pattern,
          comboId,
          priority: data.priority ?? row.priority,
          enabled: data.enabled ?? row.enabled,
          description: data.description ?? row.description,
          updatedAt: now,
        });
        return { result: mappingRecord(row, state), changed: true };
      });
    },
    deleteById: (id) =>
      store.mutate((state) => {
        const count = state.mappings.length;
        state.mappings = state.mappings.filter((row) => row.id !== id);
        const deleted = state.mappings.length !== count;
        return { result: deleted, changed: deleted };
      }),
    async resolveForModel(model) {
      const state = await store.read();
      for (const mapping of orderedMappings(state)) {
        if (!mapping.enabled || !globToRegex(mapping.pattern).test(model)) continue;
        const combo = parseCombo(state.combos.find((row) => row.id === mapping.comboId));
        if (combo && combo.isActive !== false) return combo;
      }
      return null;
    },
  };
  return { combos, modelComboMappings };
}
