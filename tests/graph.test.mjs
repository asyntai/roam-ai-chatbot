// RoamGraph against the real datascript engine (see roam-fake.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RoamGraph, isJournalUid } from "./build/graph.js";
import { makeRoam, quoteAttrs } from "./roam-fake.mjs";

test("quoteAttrs quotes attributes only", () => {
    assert.equal(
        quoteAttrs("[:find ?uid :where [?p :node/title] [?p :block/uid ?uid]]"),
        '[:find ?uid :where [?p ":node/title"] [?p ":block/uid" ?uid]]',
    );
    assert.equal(quoteAttrs("[:block/string {:block/children ...}]"), '[":block/string" {":block/children" ...}]');
});

test("journal uids", () => {
    assert.ok(isJournalUid("10-11-2026"));
    assert.ok(!isJournalUid("abc123XYZ"));
});

test("pages lists every page with its uid and title", async () => {
    const roam = makeRoam();
    roam.addPage("Docs/Refund policy", "pgRefund1", ["Refunds within 30 days."]);
    roam.addPage("October 11th, 2026", "10-11-2026", ["daily"]);
    const pages = await new RoamGraph(roam.alpha).pages();
    const byUid = Object.fromEntries(pages.map((p) => [p.uid, p]));
    assert.equal(byUid.pgRefund1.title, "Docs/Refund policy");
    assert.equal(byUid.pgRefund1.journal, false);
    assert.equal(byUid["10-11-2026"].journal, true);
});

test("blocks come back in page order, nested, with refs resolved", async () => {
    const roam = makeRoam();
    roam.addPage("Shared", "pgShared1", [["Shipping takes 3 days.", [], "refShip01"]]);
    roam.addPage("Docs/FAQ", "pgFaq0001", [
        "First block",
        ["Parent", ["Child one", "Child two"]],
        "Delivery: ((refShip01))",
        "Broken ref ((missing01))",
    ]);
    const blocks = await new RoamGraph(roam.alpha).blocks("pgFaq0001");
    assert.deepEqual(
        blocks.map((b) => b.string),
        ["First block", "Parent", "Delivery: Shipping takes 3 days.", "Broken ref "],
    );
    assert.deepEqual(
        blocks[1].children.map((b) => b.string),
        ["Child one", "Child two"],
    );
});

test("a reference to a reference is followed", async () => {
    const roam = makeRoam();
    roam.addPage("A", "pgA000001", [["Deep fact", [], "refDeep01"], ["See ((refDeep01))", [], "refMid001"]]);
    roam.addPage("Docs/B", "pgB000001", ["Answer: ((refMid001))"]);
    const blocks = await new RoamGraph(roam.alpha).blocks("pgB000001");
    assert.equal(blocks[0].string, "Answer: See Deep fact");
});

test("editTimes reads :page/edit-time: edits, renames and deletions", async () => {
    const roam = makeRoam();
    roam.addPage("Docs/X", "pgX000001", [["one", [], "blkX00001"], ["two", [], "blkX00002"]], 1000);
    roam.addPage("Docs/Empty", "pgEmpty01", [], 1500);
    const graph = new RoamGraph(roam.alpha);
    roam.editBlock("blkX00001", "one edited", 5000);
    let times = await graph.editTimes();
    assert.equal(times.pgX000001, 5000);
    assert.equal(times.pgEmpty01, 1500);
    roam.renamePage("pgEmpty01", "Docs/Empty renamed", 7000);
    assert.equal((await graph.editTimes()).pgEmpty01, 7000);
    // The reviewer's case: deleting a block. Its own :edit/time goes with
    // it, so only the page stamp shows the change.
    roam.deleteBlock("blkX00002", 9000);
    times = await graph.editTimes();
    assert.equal(times.pgX000001, 9000);
    assert.deepEqual((await graph.blocks("pgX000001")).map((b) => b.string), ["one edited"]);
});

test("refFilter keeps left-out pages out of block references", async () => {
    const roam = makeRoam();
    roam.addPage("Private/Salaries", "pgPriv001", [["Secret pay scale", [], "refPriv01"]]);
    roam.addPage("October 11th, 2026", "10-11-2026", [["Diary line", [], "refJour01"]]);
    roam.addPage("Shared", "pgShare01", [["Open fact", [], "refOpen01"]]);
    roam.addPage("Docs/Mix", "pgMix0001", ["A ((refPriv01)) B ((refJour01)) C ((refOpen01))"]);
    const graph = new RoamGraph(roam.alpha);
    assert.equal((await graph.blocks("pgMix0001"))[0].string, "A Secret pay scale B Diary line C Open fact");
    graph.refFilter = (page) => !page.title.startsWith("Private") && !page.journal;
    assert.equal((await graph.blocks("pgMix0001"))[0].string, "A  B  C Open fact");
});

test("currentPage resolves a zoomed block to its page", async () => {
    const roam = makeRoam();
    roam.addPage("Docs/Z", "pgZ000001", [["zoomed", [], "blkZ00001"]]);
    const graph = new RoamGraph(roam.alpha);
    roam.state.openUid = null;
    assert.equal(await graph.currentPage(), null);
    roam.state.openUid = "pgZ000001";
    assert.deepEqual(await graph.currentPage(), { uid: "pgZ000001", title: "Docs/Z", journal: false });
    roam.state.openUid = "blkZ00001";
    assert.deepEqual(await graph.currentPage(), { uid: "pgZ000001", title: "Docs/Z", journal: false });
});

test("append adds a block at the end; createPage reuses a title", async () => {
    const roam = makeRoam();
    roam.addPage("Notes", "pgNotes01", ["a", "b"]);
    const graph = new RoamGraph(roam.alpha);
    await graph.append("pgNotes01", "the answer");
    const blocks = await graph.blocks("pgNotes01");
    assert.deepEqual(blocks.map((b) => b.string), ["a", "b", "the answer"]);

    const uid = await graph.createPage("Asyntai chats/2026-10-11 Do you ship", ["Visitor: hi", "", "Asyntai: hello"]);
    const again = await graph.createPage("Asyntai chats/2026-10-11 Do you ship", ["Visitor: more"]);
    assert.equal(uid, again);
    assert.deepEqual((await graph.blocks(uid)).map((b) => b.string), ["Visitor: hi", "Asyntai: hello", "Visitor: more"]);
});

test("exists and pull of an unknown uid", async () => {
    const roam = makeRoam();
    roam.addPage("P", "pgP000001", ["x"]);
    const graph = new RoamGraph(roam.alpha);
    assert.equal(await graph.exists("pgP000001"), true);
    assert.equal(await graph.exists("nope00000"), false);
    assert.equal(await graph.page("nope00000"), null);
});

test("the sync-only data API works too (no data.async)", async () => {
    const roam = makeRoam();
    delete roam.alpha.data.async;
    roam.addPage("Docs/S", "pgS000001", ["sync api"]);
    const graph = new RoamGraph(roam.alpha);
    assert.equal((await graph.pages()).length, 1);
    assert.equal((await graph.blocks("pgS000001"))[0].string, "sync api");
});
