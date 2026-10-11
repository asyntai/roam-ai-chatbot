// Keeps the chosen Roam pages and the Asyntai knowledge base in step.
//
// The graph is injected as a small interface, so the engine has no Roam
// import and the tests can drive it with an in-memory graph.

import { ApiError, AsyntaiApi } from "./api";
import { BlockLike, hashText, knowledgeContent, pageText } from "./text";

/** A page shorter than this is a stub, and it is skipped. */
export const MIN_LENGTH = 120;

export interface SyncEntry {
    kb: string;
    hash: string;
    sent: number;
    title: string;
}

export type SyncMap = Record<string, SyncEntry>;

export interface GraphPage {
    /** Roam's page uid. It survives a rename, so it is the map key. */
    uid: string;
    /** The page title. Namespaces are matched on it, and it becomes the entry title. */
    title: string;
    /** Daily notes pages. */
    journal: boolean;
}

export interface GraphLike {
    /** Every page in the graph. */
    pages(): Promise<GraphPage[]>;
    /** The page's block tree, block references already resolved. */
    blocks(uid: string): Promise<BlockLike[]>;
}

/** Chats saved from the panel go here. They are never sent back to Asyntai. */
export const SAVED_CHATS_NAMESPACE = "asyntai chats";

export interface SyncOptions {
    /** Namespace prefixes, "" or "/" means the whole graph. */
    namespaces: string[];
    /** Namespace prefixes that stay out even when a parent is in. */
    excluded: string[];
    /** Whether daily journal pages are sent too. */
    journals: boolean;
}

export interface PushResult {
    ok: boolean;
    skipped: boolean;
    message: string;
}

export interface SyncAllResult {
    sent: number;
    skipped: number;
    removed: number;
    failed: number;
    errors: string[];
}

// "/" alone means the whole graph and becomes "". An empty line means nothing
// at all, so an empty setting never sends the whole graph by mistake. This is
// the same rule as the Obsidian plugin, where an empty setting once matched
// every note in the vault.
export function parseNamespaces(raw: string): string[] {
    const out: string[] = [];
    for (const piece of (raw || "").split(/[\n,]+/)) {
        const token = piece.trim();
        if (token === "") {
            continue;
        }
        const namespace = token.replace(/^\/+|\/+$/g, "").toLowerCase();
        if (!out.includes(namespace)) {
            out.push(namespace);
        }
    }
    return out;
}

function inNamespace(name: string, namespace: string): boolean {
    if (namespace === "" || namespace === "/") {
        return true;
    }
    return name === namespace || name.startsWith(namespace + "/");
}

/** Whether a page belongs in the knowledge base at all. */
export function shouldSync(page: GraphPage, options: SyncOptions): boolean {
    const name = (page.title || "").trim().toLowerCase();
    if (!name || !page.uid) {
        return false;
    }
    if (inNamespace(name, SAVED_CHATS_NAMESPACE)) {
        return false;
    }
    if (page.journal && !options.journals) {
        return false;
    }
    const namespaces = options.namespaces.filter((n) => n !== undefined);
    if (namespaces.length === 0) {
        return false;
    }
    for (const excluded of options.excluded) {
        if (excluded !== "" && inNamespace(name, excluded)) {
            return false;
        }
    }
    return namespaces.some((namespace) => inNamespace(name, namespace));
}

export class SyncEngine {
    private api: AsyntaiApi;
    private graph: GraphLike;
    private map: SyncMap;
    private save: (map: SyncMap) => Promise<void>;
    private options: () => SyncOptions;
    // Every write runs one at a time. Two runs side by side (the watcher
    // during "send all", or "send all" pressed twice) both saw a page as
    // unsent and both added it, so Asyntai held the page twice.
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        api: AsyntaiApi,
        graph: GraphLike,
        map: SyncMap,
        save: (map: SyncMap) => Promise<void>,
        options: () => SyncOptions,
    ) {
        this.api = api;
        this.graph = graph;
        this.map = map;
        this.save = save;
        this.options = options;
    }

    entries(): SyncMap {
        return this.map;
    }

    count(): number {
        return Object.keys(this.map).length;
    }

    isSynced(uid: string): boolean {
        return Boolean(this.map[uid]?.kb);
    }

    /** When a page was last sent, 0 if never. */
    sentAt(uid: string): number {
        return this.map[uid]?.sent || 0;
    }

    wanted(page: GraphPage): boolean {
        return shouldSync(page, this.options());
    }

    private exclusive<T>(work: () => Promise<T>): Promise<T> {
        const run = this.queue.then(work, work);
        this.queue = run.catch(() => undefined);
        return run;
    }

    /**
     * Send one page. A page already in the knowledge base is replaced: the
     * new entry goes up first, then the old one is removed, so the chatbot
     * never has a gap.
     */
    push(page: GraphPage, blocks?: BlockLike[]): Promise<PushResult> {
        return this.exclusive(() => this.pushNow(page, blocks));
    }

    /** Remove a page from the knowledge base, if it was ever sent. */
    remove(uid: string): Promise<boolean> {
        return this.exclusive(() => this.removeNow(uid));
    }

    private async pushNow(page: GraphPage, blocks?: BlockLike[]): Promise<PushResult> {
        const tree = blocks === undefined ? await this.graph.blocks(page.uid) : blocks;
        const parsed = pageText(tree, page.title);
        if (parsed.text.length < MIN_LENGTH) {
            // Too short to answer anything. Drop a stale copy.
            await this.removeNow(page.uid);
            return { ok: true, skipped: true, message: "Page is too short to send." };
        }

        const body = knowledgeContent(parsed);
        const hash = hashText(body);
        const known = this.map[page.uid];
        if (known && known.hash === hash && known.kb) {
            // Unchanged, but the edit time still moved: remember it, so the
            // watcher does not look at this page again until it is edited.
            known.sent = Date.now();
            await this.save(this.map);
            return { ok: true, skipped: true, message: "Page is unchanged." };
        }

        let kb: string;
        try {
            kb = await this.api.addText(parsed.title, body);
        } catch (err) {
            return { ok: false, skipped: false, message: errorText(err) };
        }

        const old = known?.kb;
        this.map[page.uid] = { kb, hash, sent: Date.now(), title: parsed.title };
        await this.save(this.map);

        if (old && old !== kb) {
            try {
                await this.api.deleteEntry(old);
            } catch {
                // The new entry is live; a leftover copy is harmless.
            }
        }
        return { ok: true, skipped: false, message: "Page sent to Asyntai." };
    }

    private async removeNow(uid: string): Promise<boolean> {
        const known = this.map[uid];
        if (!known?.kb) {
            return true;
        }
        try {
            await this.api.deleteEntry(known.kb);
        } catch {
            return false;
        }
        delete this.map[uid];
        await this.save(this.map);
        return true;
    }

    /** Send every wanted page and remove every page that is no longer wanted. */
    syncAll(onProgress?: (done: number, total: number) => void): Promise<SyncAllResult> {
        return this.exclusive(() => this.syncAllNow(onProgress));
    }

    private async syncAllNow(onProgress?: (done: number, total: number) => void): Promise<SyncAllResult> {
        const result: SyncAllResult = { sent: 0, skipped: 0, removed: 0, failed: 0, errors: [] };
        const all = await this.graph.pages();
        const pages = all.filter((p) => this.wanted(p));
        const present = new Set(pages.map((p) => p.uid));

        // Entries whose page is gone, or moved out of the namespaces.
        for (const uid of Object.keys(this.map)) {
            if (!present.has(uid)) {
                const title = this.map[uid]?.title || uid;
                if (await this.removeNow(uid)) {
                    result.removed += 1;
                } else {
                    result.failed += 1;
                    result.errors.push(`${title}: could not remove`);
                }
            }
        }

        let done = 0;
        for (const page of pages) {
            const r = await this.pushNow(page);
            if (!r.ok) {
                result.failed += 1;
                result.errors.push(`${page.title}: ${r.message}`);
            } else if (r.skipped) {
                result.skipped += 1;
            } else {
                result.sent += 1;
            }
            done += 1;
            onProgress?.(done, pages.length);
        }
        return result;
    }

    /** Remove every synced page from the knowledge base. */
    removeAll(): Promise<number> {
        return this.exclusive(async () => {
            let removed = 0;
            for (const uid of Object.keys(this.map)) {
                if (await this.removeNow(uid)) {
                    removed += 1;
                }
            }
            return removed;
        });
    }
}

export function errorText(err: unknown): string {
    if (err instanceof ApiError) {
        return err.message;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}
