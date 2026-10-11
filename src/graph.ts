// Everything that reads or writes the Roam graph.
//
// The Roam API object is passed in, never read from `window` here, so the
// tests can hand in a graph built on the real datascript engine. Reads use
// the async API when Roam offers it, and the older sync one otherwise.

import { GraphLike, GraphPage } from "./sync";
import { BlockLike, blockRefs, resolveBlockRefs } from "./text";

type Pulled = Record<string, unknown> | null;

/** The subset of window.roamAlphaAPI this extension uses. */
export interface RoamAlpha {
    data: {
        q: (query: string, ...args: unknown[]) => unknown;
        pull: (pattern: string, eid: unknown) => unknown;
        async?: {
            q: (query: string, ...args: unknown[]) => Promise<unknown>;
            pull: (pattern: string, eid: unknown) => Promise<unknown>;
        };
        block: {
            create: (args: { location: { "parent-uid": string; order: number | "first" | "last" }; block: { string: string } }) => unknown;
        };
        page: {
            create: (args: { page: { title: string } }) => unknown;
        };
    };
    ui: {
        mainWindow?: { getOpenPageOrBlockUid?: () => unknown };
        getFocusedBlock?: () => { "block-uid"?: string } | null;
    };
}

/** Daily notes pages have a uid like 10-11-2026. */
export function isJournalUid(uid: string): boolean {
    return /^\d{2}-\d{2}-\d{4}$/.test(uid || "");
}

/** Roam answers pulls with ":block/string" keys; tolerate keys without the colon too. */
function field<T>(entity: Pulled | undefined, name: string): T | undefined {
    if (!entity) {
        return undefined;
    }
    const value = entity[`:${name}`] ?? entity[name];
    return value as T | undefined;
}

const TREE = "[:block/string :block/order :block/heading {:block/children ...}]";
const PAGE_TREE = `[:node/title {:block/children ${TREE}}]`;

function toBlock(entity: Pulled): BlockLike {
    const children = field<Pulled[]>(entity, "block/children") || [];
    return {
        string: field<string>(entity, "block/string") || "",
        order: field<number>(entity, "block/order") ?? 0,
        heading: field<number>(entity, "block/heading"),
        children: children.map(toBlock),
    };
}

function walk(blocks: BlockLike[], visit: (block: BlockLike) => void): void {
    for (const block of blocks) {
        visit(block);
        walk(block.children || [], visit);
    }
}

/** How deep a reference to a reference is followed. */
const REF_DEPTH = 3;

export class RoamGraph implements GraphLike {
    private alpha: RoamAlpha;

    constructor(alpha: RoamAlpha) {
        this.alpha = alpha;
    }

    private q(query: string, ...args: unknown[]): Promise<unknown> {
        const reader = this.alpha.data.async?.q ?? this.alpha.data.q;
        return Promise.resolve(reader.call(this.alpha.data.async ?? this.alpha.data, query, ...args));
    }

    private pull(pattern: string, eid: unknown): Promise<Pulled> {
        const reader = this.alpha.data.async?.pull ?? this.alpha.data.pull;
        return Promise.resolve(reader.call(this.alpha.data.async ?? this.alpha.data, pattern, eid)) as Promise<Pulled>;
    }

    async pages(): Promise<GraphPage[]> {
        const rows = (await this.q("[:find ?uid ?title :where [?p :node/title ?title] [?p :block/uid ?uid]]")) as Array<
            [string, string]
        >;
        return (rows || [])
            .filter((row) => row && row[0] && row[1])
            .map(([uid, title]) => ({ uid, title, journal: isJournalUid(uid) }));
    }

    async page(uid: string): Promise<GraphPage | null> {
        const entity = await this.pull("[:node/title :block/uid]", [":block/uid", uid]);
        const title = field<string>(entity, "node/title");
        if (!title) {
            return null;
        }
        return { uid, title, journal: isJournalUid(uid) };
    }

    /** The newest edit time of every page: the page itself or any block on it. */
    async editTimes(): Promise<Record<string, number>> {
        const out: Record<string, number> = {};
        const note = (rows: unknown): void => {
            for (const row of (rows as Array<[string, number]>) || []) {
                const [uid, time] = row;
                if (uid && typeof time === "number" && time > (out[uid] || 0)) {
                    out[uid] = time;
                }
            }
        };
        note(
            await this.q(
                "[:find ?uid (max ?t) :where [?p :node/title] [?p :block/uid ?uid] [?b :block/page ?p] [?b :edit/time ?t]]",
            ),
        );
        note(await this.q("[:find ?uid ?t :where [?p :node/title] [?p :block/uid ?uid] [?p :edit/time ?t]]"));
        return out;
    }

    async blocks(uid: string): Promise<BlockLike[]> {
        const entity = await this.pull(PAGE_TREE, [":block/uid", uid]);
        const blocks = (field<Pulled[]>(entity, "block/children") || []).map(toBlock);
        await this.resolveRefs(blocks);
        return blocks;
    }

    /** Swaps every ((uid)) for the text of the block it points at. */
    private async resolveRefs(blocks: BlockLike[]): Promise<void> {
        // Raw texts first, round by round, so a reference inside a
        // referenced block is fetched before anything is replaced.
        const raw: Record<string, string> = {};
        let wanted = new Set<string>();
        walk(blocks, (block) => blockRefs(block.string || "").forEach((ref) => wanted.add(ref)));
        for (let depth = 0; depth < REF_DEPTH && wanted.size; depth++) {
            const next = new Set<string>();
            for (const ref of wanted) {
                let text = "";
                try {
                    text = field<string>(await this.pull("[:block/string]", [":block/uid", ref]), "block/string") || "";
                } catch {
                    text = "";
                }
                raw[ref] = text;
                for (const inner of blockRefs(text)) {
                    if (!(inner in raw)) {
                        next.add(inner);
                    }
                }
            }
            wanted = next;
        }
        // Then replace, inner references first. A cycle or a reference past
        // REF_DEPTH resolves to nothing.
        const resolved: Record<string, string> = {};
        const resolve = (ref: string, depth: number): string => {
            if (ref in resolved) {
                return resolved[ref];
            }
            if (!(ref in raw) || depth >= REF_DEPTH) {
                return "";
            }
            resolved[ref] = "";
            const text = raw[ref].replace(/\(\(([A-Za-z0-9_-]{9})\)\)/g, (_all, inner: string) => resolve(inner, depth + 1));
            resolved[ref] = text;
            return text;
        };
        const lookup: Record<string, string> = {};
        for (const ref of Object.keys(raw)) {
            lookup[ref] = resolve(ref, 0);
        }
        walk(blocks, (block) => {
            block.string = resolveBlockRefs(block.string || "", lookup);
        });
    }

    /**
     * The page open in the main window. When a single block is zoomed in,
     * that block's page. Null on the daily notes log, where no page is open.
     */
    async currentPage(): Promise<GraphPage | null> {
        const getter = this.alpha.ui.mainWindow?.getOpenPageOrBlockUid;
        if (!getter) {
            return null;
        }
        const uid = (await Promise.resolve(getter.call(this.alpha.ui.mainWindow))) as string | null;
        if (!uid) {
            return null;
        }
        const entity = await this.pull("[:node/title {:block/page [:block/uid :node/title]}]", [":block/uid", uid]);
        const title = field<string>(entity, "node/title");
        if (title) {
            return { uid, title, journal: isJournalUid(uid) };
        }
        const page = field<Pulled>(entity, "block/page");
        const pageUid = field<string>(page, "block/uid");
        const pageTitle = field<string>(page, "node/title");
        if (pageUid && pageTitle) {
            return { uid: pageUid, title: pageTitle, journal: isJournalUid(pageUid) };
        }
        return null;
    }

    /** The uid of the main window's page or zoomed block, for appending. */
    async openUid(): Promise<string | null> {
        const getter = this.alpha.ui.mainWindow?.getOpenPageOrBlockUid;
        if (!getter) {
            return null;
        }
        return ((await Promise.resolve(getter.call(this.alpha.ui.mainWindow))) as string | null) || null;
    }

    focusedBlockUid(): string | null {
        try {
            return this.alpha.ui.getFocusedBlock?.()?.["block-uid"] || null;
        } catch {
            return null;
        }
    }

    async exists(uid: string): Promise<boolean> {
        const entity = await this.pull("[:block/uid]", [":block/uid", uid]);
        return Boolean(field<string>(entity, "block/uid"));
    }

    /** Adds one block at the end of a page or under a block. */
    async append(parentUid: string, text: string): Promise<void> {
        await Promise.resolve(
            this.alpha.data.block.create({ location: { "parent-uid": parentUid, order: "last" }, block: { string: text } }),
        );
    }

    async pageUidByTitle(title: string): Promise<string | null> {
        const entity = await this.pull("[:block/uid]", [":node/title", title]);
        return field<string>(entity, "block/uid") || null;
    }

    /** Makes a page, or reuses the page with that title, and fills it with blocks. */
    async createPage(title: string, lines: string[]): Promise<string> {
        // Roam's docs: let page.create pick the uid, then look it up by title.
        let uid = await this.pageUidByTitle(title);
        if (!uid) {
            await Promise.resolve(this.alpha.data.page.create({ page: { title } }));
            uid = await this.pageUidByTitle(title);
        }
        if (!uid) {
            throw new Error("Roam did not create the page.");
        }
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            await Promise.resolve(
                this.alpha.data.block.create({ location: { "parent-uid": uid, order: "last" }, block: { string: line } }),
            );
        }
        return uid;
    }
}
