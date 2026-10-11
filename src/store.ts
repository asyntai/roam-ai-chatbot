// How the sync map is kept in the extension settings.
//
// It is stored as one JSON string under one key. A string is replaced whole,
// so a page removed from the map stays removed: the Logseq port lost
// deletions because its settings store deep-merged objects.

import { SyncMap } from "./sync";

export const MAP_KEY = "syncMapJson";

export function serializeMap(map: SyncMap): string {
    return JSON.stringify(map);
}

export function parseMap(stored: unknown): SyncMap {
    if (typeof stored === "string" && stored) {
        try {
            const parsed = JSON.parse(stored) as SyncMap;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch {
            // A damaged string means a full re-send, which is safe.
        }
    }
    return {};
}
