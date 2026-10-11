// A stand-in for window.roamAlphaAPI, built on the real datascript engine
// that Roam itself runs on, so the extension's datalog queries and pull
// patterns are executed for real, not matched as strings.
//
// One difference has to be bridged: in Roam an attribute is a keyword, while
// datascript's JS build stores attribute names as plain strings and parses
// ":block/uid" in a query string as a keyword. Every namespaced keyword in a
// query or pull pattern is therefore quoted before it reaches datascript.
// Keywords without a slash (:find, :where, :in) stay keywords.

import d from "datascript";

const SCHEMA = {
    ":block/uid": { ":db/unique": ":db.unique/identity" },
    ":node/title": { ":db/unique": ":db.unique/identity" },
    ":block/children": { ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
    ":block/page": { ":db/valueType": ":db.type/ref" },
};

export function quoteAttrs(edn) {
    return edn.replace(/(^|[\s[{(])(:[A-Za-z][\w.-]*\/[\w.*+!?<>=-]+)/g, '$1"$2"');
}

function lookup(eid) {
    if (Array.isArray(eid) && eid.length === 2 && typeof eid[0] === "string") {
        return [eid[0], eid[1]];
    }
    return eid;
}

let uidCounter = 0;

export function makeRoam({ now = () => Date.now() } = {}) {
    let db = d.empty_db(SCHEMA);
    const state = { openUid: null, focusedUid: null, created: [] };

    const transact = (tx) => {
        db = d.db_with(db, tx);
    };

    const q = (query, ...args) => d.q(quoteAttrs(query), db, ...args);
    const pull = (pattern, eid) => {
        try {
            return d.pull(db, quoteAttrs(pattern), lookup(eid));
        } catch (err) {
            // Roam answers null for an unknown lookup ref.
            if (/Nothing found|lookup/i.test(String(err && err.message))) {
                return null;
            }
            throw err;
        }
    };

    const entityId = (uid) => d.q('[:find ?e . :in $ ?u :where [?e ":block/uid" ?u]]', db, uid);

    const pageOf = (uid) => {
        const e = entityId(uid);
        if (e == null) {
            return null;
        }
        const ent = d.pull(db, '[":node/title" {":block/page" [":db/id"]}]', e);
        if (ent && ent[":node/title"] !== undefined) {
            return e;
        }
        return ent && ent[":block/page"] ? ent[":block/page"][":db/id"] : null;
    };

    const alpha = {
        data: {
            q,
            pull,
            async: { q: async (...a) => q(...a), pull: async (...a) => pull(...a) },
            block: {
                create: async ({ location, block }) => {
                    const parent = entityId(location["parent-uid"]);
                    if (parent == null) {
                        throw new Error(`no parent ${location["parent-uid"]}`);
                    }
                    const uid = block.uid || alpha.util.generateUID();
                    const siblings = (d.pull(db, '[{":block/children" [":block/order"]}]', parent) || {})[":block/children"] || [];
                    const last = siblings.reduce((m, c) => Math.max(m, c[":block/order"] ?? -1), -1) + 1;
                    const order = location.order === "last" ? last : location.order === "first" ? -1 : location.order;
                    transact([
                        {
                            ":db/id": -1,
                            ":block/uid": uid,
                            ":block/string": block.string,
                            ":block/order": order,
                            ":block/page": pageOf(location["parent-uid"]),
                            ":edit/time": now(),
                        },
                        { ":db/id": parent, ":block/children": [-1] },
                    ]);
                    state.created.push({ parent: location["parent-uid"], order, string: block.string, uid });
                },
                update: async ({ block }) => {
                    transact([{ ":block/uid": block.uid, ":block/string": block.string, ":edit/time": now() }]);
                },
            },
            page: {
                create: async ({ page }) => {
                    transact([{ ":block/uid": page.uid || alpha.util.generateUID(), ":node/title": page.title, ":edit/time": now() }]);
                },
                delete: async ({ page }) => {
                    const e = entityId(page.uid);
                    const blocks = d.q('[:find [?b ...] :in $ ?p :where [?b ":block/page" ?p]]', db, e) || [];
                    transact([...blocks.map((b) => [":db.fn/retractEntity", b]), [":db.fn/retractEntity", e]]);
                },
            },
        },
        util: {
            generateUID: () => {
                uidCounter += 1;
                return `t${String(uidCounter).padStart(8, "0")}`.slice(-9);
            },
        },
        ui: {
            mainWindow: { getOpenPageOrBlockUid: async () => state.openUid },
            getFocusedBlock: () => (state.focusedUid ? { "block-uid": state.focusedUid, "window-id": "main" } : null),
        },
    };

    // Helpers for tests: build pages from nested arrays.
    //   addPage("Docs/Refund", "pg1", ["line", ["parent", ["child"]]], 1000)
    const addPage = (title, uid, blocks, time = now()) => {
        transact([{ ":block/uid": uid, ":node/title": title, ":edit/time": time }]);
        const pageE = entityId(uid);
        const addBlocks = (parentE, items) => {
            items.forEach((item, order) => {
                const [text, children, buid] = Array.isArray(item) ? item : [item, [], null];
                const blockUid = buid || alpha.util.generateUID();
                transact([
                    {
                        ":db/id": -1,
                        ":block/uid": blockUid,
                        ":block/string": text,
                        ":block/order": order,
                        ":block/page": pageE,
                        ":edit/time": time,
                    },
                    { ":db/id": parentE, ":block/children": [-1] },
                ]);
                if (children && children.length) {
                    addBlocks(entityId(blockUid), children);
                }
            });
        };
        addBlocks(pageE, blocks);
        return uid;
    };

    const editBlock = (uid, string, time = now()) => {
        transact([{ ":block/uid": uid, ":block/string": string, ":edit/time": time }]);
    };

    const renamePage = (uid, title, time = now()) => {
        transact([{ ":block/uid": uid, ":node/title": title, ":edit/time": time }]);
    };

    return { alpha, state, addPage, editBlock, renamePage, db: () => db };
}
