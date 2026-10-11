// Text cleaning, the sync engine and the small helpers. No Roam, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { roamToText, flattenBlocks, pageText, blockRefs, resolveBlockRefs, hashText } from "./build/text.js";
import { SyncEngine, shouldSync, parseNamespaces, MIN_LENGTH } from "./build/sync.js";
import { AsyntaiApi, isOwnQuestion, newAskSession } from "./build/api.js";
import { parseMap, serializeMap } from "./build/store.js";
import { chatTitle } from "./build/ui.js";
import { questionFromBlock, pages } from "./build/index.js";

test("page links, tags and aliases keep their words", () => {
    assert.equal(roamToText("See [[Refund policy]] and #shipping and #[[Gift cards]]."), "See Refund policy and shipping and Gift cards.");
    assert.equal(roamToText("Read [the terms]([[Terms of sale]]) first."), "Read the terms first.");
    assert.equal(roamToText("Nested [[[[Docs]]/Refund]] link"), "Nested Docs/Refund link");
});

test("a line that is only tags is dropped", () => {
    assert.equal(roamToText("#draft #[[to review]]\nReal text"), "Real text");
});

test("attributes keep name and value", () => {
    assert.equal(roamToText("Price:: 20 EUR\nWarranty:: [[3 years]]"), "Price: 20 EUR\nWarranty: 3 years");
});

test("tasks lose the box, widgets and math go", () => {
    assert.equal(roamToText("{{[[TODO]]}} Ship the order"), "Ship the order");
    assert.equal(roamToText("{{[[DONE]]}}Done task"), "Done task");
    assert.equal(roamToText("Before {{embed: ((abcdefghi))}} after"), "Before after");
    assert.equal(roamToText("{{query: {and: [[x]]}}}\nKept"), "Kept");
    assert.equal(roamToText("Area $$\\pi r^2$$ here"), "Area here");
});

test("markdown links keep the address; images go", () => {
    assert.equal(roamToText("Visit [our shop](https://shop.example.com/a) now"), "Visit our shop (https://shop.example.com/a) now");
    assert.equal(roamToText("![logo](https://x/y.png)Hello"), "Hello");
});

test("formatting is stripped", () => {
    assert.equal(roamToText("**bold** __italic__ ^^mark^^ ~~gone~~ `code`"), "bold italic mark gone code");
    assert.equal(roamToText("> quoted"), "quoted");
});

test("an unresolved block ref is removed", () => {
    assert.equal(roamToText("x ((abcdefghi)) y"), "x y");
});

test("block refs are found and resolved", () => {
    assert.deepEqual(blockRefs("((abcdefghi)) and ((ABCDEFGHI)) and ((abcdefghi))"), ["abcdefghi", "ABCDEFGHI"]);
    assert.equal(resolveBlockRefs("a ((abcdefghi)) b ((zzzzzzzzz))", { abcdefghi: "TEXT" }), "a TEXT b ");
});

test("flattenBlocks sorts by order and indents children", () => {
    const text = flattenBlocks([
        { string: "second", order: 1 },
        { string: "first", order: 0, children: [{ string: "child", order: 0 }] },
    ]);
    assert.equal(text, "first\n  child\nsecond");
});

test("pageText puts the title on top", () => {
    const page = pageText([{ string: "Body", order: 0 }], " Docs/Refund ");
    assert.equal(page.title, "Docs/Refund");
    assert.equal(page.text, "Body");
});

test("hashText is stable and sensitive", () => {
    assert.equal(hashText("a"), hashText("a"));
    assert.notEqual(hashText("a"), hashText("b"));
});

test("parseNamespaces: empty means nothing, / means all", () => {
    assert.deepEqual(parseNamespaces(""), []);
    assert.deepEqual(parseNamespaces("/"), [""]);
    assert.deepEqual(parseNamespaces("Docs, Help center\nDocs"), ["docs", "help center"]);
});

test("shouldSync matches title prefixes, case-insensitive", () => {
    const opts = { namespaces: ["docs"], excluded: ["docs/drafts"], journals: false };
    assert.ok(shouldSync({ uid: "a", title: "Docs", journal: false }, opts));
    assert.ok(shouldSync({ uid: "a", title: "Docs/Refund policy", journal: false }, opts));
    assert.ok(!shouldSync({ uid: "a", title: "Docsify", journal: false }, opts));
    assert.ok(!shouldSync({ uid: "a", title: "Docs/Drafts/x", journal: false }, opts));
    assert.ok(!shouldSync({ uid: "", title: "Docs/x", journal: false }, opts));
});

test("journals and saved chats stay out", () => {
    const all = { namespaces: [""], excluded: [], journals: false };
    assert.ok(!shouldSync({ uid: "10-11-2026", title: "October 11th, 2026", journal: true }, all));
    assert.ok(shouldSync({ uid: "10-11-2026", title: "October 11th, 2026", journal: true }, { ...all, journals: true }));
    assert.ok(!shouldSync({ uid: "x", title: "Asyntai chats/2026-10-11 hello", journal: false }, all));
    assert.ok(shouldSync({ uid: "x", title: "Anything", journal: false }, all));
});

// A fake Asyntai server behind the transport.
function fakeServer() {
    const entries = new Map();
    const calls = [];
    let next = 1;
    const transport = async (req) => {
        calls.push(`${req.method} ${req.url.replace("https://asyntai.com", "")}`);
        const path = req.url.replace("https://asyntai.com", "");
        if (req.headers.Authorization !== "Bearer key-ok") {
            return { status: 401, text: "{}" };
        }
        if (req.method === "POST" && path === "/api/v1/knowledge/text/") {
            const body = JSON.parse(req.body);
            const id = `kb${next++}`;
            entries.set(id, body);
            return { status: 201, text: JSON.stringify({ success: true, id }) };
        }
        const del = path.match(/^\/api\/v1\/knowledge\/([^/]+)\/$/);
        if (req.method === "DELETE" && del) {
            if (!entries.has(del[1])) {
                return { status: 404, text: JSON.stringify({ success: false, error: "not found" }) };
            }
            entries.delete(del[1]);
            return { status: 200, text: JSON.stringify({ success: true }) };
        }
        if (path.startsWith("/api/v1/sessions/")) {
            return {
                status: 200,
                text: JSON.stringify({
                    success: true,
                    sessions: [{ session_id: "session_1" }, { session_id: "roam_ask_123_abc" }],
                }),
            };
        }
        return { status: 404, text: "{}" };
    };
    return { entries, calls, transport };
}

const LONG = "This page explains the refund policy in detail. ".repeat(4);

function fakeGraph(pages) {
    return {
        pages: async () => pages.map((p) => ({ uid: p.uid, title: p.title, journal: false })),
        blocks: async (uid) => pages.find((p) => p.uid === uid).blocks,
    };
}

function engineWith(pages, map = {}, opts = { namespaces: ["docs"], excluded: [], journals: false }, key = "key-ok") {
    const server = fakeServer();
    const api = new AsyntaiApi(server.transport, () => key);
    const saved = [];
    const engine = new SyncEngine(api, fakeGraph(pages), map, async (m) => saved.push(JSON.parse(JSON.stringify(m))), () => opts);
    return { server, engine, saved };
}

test("push sends a page, skips it unchanged, replaces it when edited", async () => {
    const page = { uid: "pg1", title: "Docs/Refund", blocks: [{ string: LONG, order: 0 }] };
    const { server, engine } = engineWith([page]);
    let r = await engine.push(page);
    assert.equal(r.ok && !r.skipped, true);
    assert.equal(server.entries.size, 1);
    const first = engine.entries().pg1.kb;
    assert.ok(server.entries.get(first).content.startsWith("Docs/Refund\n\n"));

    r = await engine.push(page);
    assert.equal(r.skipped, true);
    assert.equal(r.message, "Page is unchanged.");

    page.blocks = [{ string: LONG + " Changed.", order: 0 }];
    r = await engine.push(page);
    assert.equal(r.skipped, false);
    assert.equal(server.entries.size, 1, "old entry replaced, not duplicated");
    assert.notEqual(engine.entries().pg1.kb, first);
});

test("a short page is skipped and an old copy removed", async () => {
    const page = { uid: "pg1", title: "Docs/Short", blocks: [{ string: LONG, order: 0 }] };
    const { server, engine } = engineWith([page]);
    await engine.push(page);
    page.blocks = [{ string: "tiny", order: 0 }];
    const r = await engine.push(page);
    assert.equal(r.message, "Page is too short to send.");
    assert.equal(server.entries.size, 0);
    assert.equal(engine.isSynced("pg1"), false);
    assert.ok(MIN_LENGTH > "tiny".length);
});

test("syncAll sends wanted pages and removes gone ones", async () => {
    const pages = [
        { uid: "a", title: "Docs/A", blocks: [{ string: LONG, order: 0 }] },
        { uid: "b", title: "Private/B", blocks: [{ string: LONG, order: 0 }] },
        { uid: "c", title: "Docs/C", blocks: [{ string: "short", order: 0 }] },
    ];
    const { server, engine } = engineWith(pages, { gone: { kb: "kbOld", hash: "x", sent: 1, title: "Old" } });
    server.entries.set("kbOld", { title: "Old" });
    const result = await engine.syncAll();
    assert.deepEqual([result.sent, result.skipped, result.removed, result.failed], [1, 1, 1, 0]);
    assert.ok(engine.isSynced("a"));
    assert.ok(!engine.isSynced("b"));
    assert.ok(!engine.isSynced("gone"));
    assert.equal(server.entries.has("kbOld"), false);
});

test("two syncs at the same time never add a page twice", async () => {
    const pages = [
        { uid: "a", title: "Docs/A", blocks: [{ string: LONG, order: 0 }] },
        { uid: "b", title: "Docs/B", blocks: [{ string: LONG, order: 0 }] },
    ];
    const { server, engine } = engineWith(pages);
    const [first, second] = await Promise.all([engine.syncAll(), engine.syncAll(), engine.push({ uid: "a", title: "Docs/A", journal: false })]);
    assert.equal(server.entries.size, 2, "one entry per page");
    assert.equal(first.sent + second.sent, 2);
});

test("removing an entry Asyntai already lost still clears the map", async () => {
    const { engine } = engineWith([], { x: { kb: "kbMissing", hash: "h", sent: 1, title: "X" } });
    assert.equal(await engine.remove("x"), true);
    assert.equal(engine.isSynced("x"), false);
});

test("a bad key fails cleanly and keeps the map", async () => {
    const page = { uid: "pg1", title: "Docs/A", blocks: [{ string: LONG, order: 0 }] };
    const { engine } = engineWith([page], {}, undefined, "wrong");
    const r = await engine.push(page);
    assert.equal(r.ok, false);
    assert.equal(r.message, "Asyntai does not accept this API key.");
    assert.equal(engine.count(), 0);
});

test("empty key gives the settings hint", async () => {
    const api = new AsyntaiApi(async () => ({ status: 200, text: "{}" }), () => "  ");
    await assert.rejects(api.account(), /Settings > Asyntai AI Chatbot/);
});

test("own questions are hidden from Chats", async () => {
    const server = fakeServer();
    const api = new AsyntaiApi(server.transport, () => "key-ok");
    const sessions = await api.sessions();
    assert.deepEqual(sessions.map((s) => s.session_id), ["session_1"]);
    assert.ok(isOwnQuestion(newAskSession()));
});

test("the sync map survives a round trip and a damaged value", () => {
    const map = { a: { kb: "k", hash: "h", sent: 5, title: "A" } };
    assert.deepEqual(parseMap(serializeMap(map)), map);
    assert.deepEqual(parseMap("{oops"), {});
    assert.deepEqual(parseMap(undefined), {});
    assert.deepEqual(parseMap("[1,2]"), {});
});

test("questionFromBlock cuts the slash command", () => {
    assert.equal(questionFromBlock("Do we ship to Spain? /Asyntai ask"), "Do we ship to Spain?");
    assert.equal(questionFromBlock("Do we ship to Spain? /asy"), "Do we ship to Spain?");
    // Roam's indexes cover the search text after the "/".
    const text = "Is it a/b test? /Asyntai ask";
    assert.equal(questionFromBlock(text, [17, text.length]), "Is it a/b test?");
    // A span that starts at the "/" works too.
    assert.equal(questionFromBlock(text, [16, text.length]), "Is it a/b test?");
    assert.equal(questionFromBlock("/Asyntai ask"), "");
});

test("chatTitle is short and has no Roam markup", () => {
    const title = chatTitle({
        session_id: "session_1",
        first_message: "Do you ship [[to]] #Spain/Portugal?",
        first_message_at: "2026-10-11T10:00:00Z",
    });
    assert.equal(title, "2026-10-11 Do you ship to Spain Portugal?");
    assert.ok(!title.includes("/"));
});

test("page counts read correctly", () => {
    assert.equal(pages(0), "0 pages");
    assert.equal(pages(1), "1 page");
    assert.equal(pages(4), "4 pages");
});
