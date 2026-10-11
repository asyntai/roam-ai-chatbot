// Turns a Roam page into the text the chatbot answers from.
//
// A Roam page is a tree of blocks. The tree is flattened first, keeping the
// nesting as indentation, and then the Roam markup is cleaned: attributes,
// task boxes, embeds and queries carry nothing a visitor can be told. Page
// links keep their title, block references are swapped for the text they
// point at before this module runs.

export interface PageText {
    title: string;
    text: string;
}

/** The parts of a pulled Roam block this module needs. */
export interface BlockLike {
    string?: string;
    order?: number;
    children?: BlockLike[];
    heading?: number;
}

/** Roam keeps children in a set; :block/order gives the order on the page. */
export function sortBlocks(blocks: BlockLike[]): BlockLike[] {
    return [...(blocks || [])].filter(Boolean).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Flattens the block tree into one text. A child block is indented under its
 * parent, so it still reads as a detail of that parent.
 */
export function flattenBlocks(blocks: BlockLike[], depth = 0): string {
    const lines: string[] = [];
    for (const block of sortBlocks(blocks)) {
        const content = (typeof block.string === "string" ? block.string : "").trim();
        if (content) {
            const indent = "  ".repeat(depth);
            for (const line of content.split(/\r?\n/)) {
                lines.push(line.trim() ? indent + line.trim() : "");
            }
        }
        if (block.children && block.children.length) {
            const nested = flattenBlocks(block.children, depth + 1);
            if (nested) {
                lines.push(nested);
            }
        }
    }
    return lines.join("\n");
}

/** A Roam block uid is nine characters of [A-Za-z0-9_-]. */
export const BLOCK_REF = /\(\(([A-Za-z0-9_-]{9})\)\)/g;

/** Every block uid referenced as ((uid)) in a text. */
export function blockRefs(text: string): string[] {
    const out: string[] = [];
    for (const match of (text || "").matchAll(BLOCK_REF)) {
        if (!out.includes(match[1])) {
            out.push(match[1]);
        }
    }
    return out;
}

/** Swaps every ((uid)) for the referenced text; an unknown uid is dropped. */
export function resolveBlockRefs(text: string, lookup: Record<string, string>): string {
    return (text || "").replace(BLOCK_REF, (_all, uid: string) => lookup[uid] ?? "");
}

/**
 * Removes every {{...}} widget. A query nests braces, as in
 * {{query: {and: [[x]]}}}, so the closing pair is found by counting.
 */
export function stripWidgets(text: string): string {
    let out = "";
    let i = 0;
    while (i < text.length) {
        const start = text.indexOf("{{", i);
        if (start === -1) {
            out += text.slice(i);
            break;
        }
        out += text.slice(i, start);
        let depth = 0;
        let j = start;
        for (; j < text.length; j++) {
            if (text[j] === "{") {
                depth += 1;
            } else if (text[j] === "}") {
                depth -= 1;
                if (depth === 0) {
                    break;
                }
            }
        }
        if (depth !== 0) {
            // No closing brace: keep the rest as typed.
            out += text.slice(start);
            break;
        }
        i = j + 1;
    }
    return out;
}

export function roamToText(body: string): string {
    let text = (body || "").replace(/\r\n/g, "\n");

    // Task boxes keep the task, lose the box.
    text = text.replace(/\{\{\s*\[\[(?:TODO|DONE)\]\]\s*\}\}\s*/g, "");
    // Every other {{...}} is a widget: embeds, queries, tables, timers, buttons.
    text = stripWidgets(text);

    // Attributes are "Name:: value" at the start of a line. The value is kept
    // as "Name: value", because "Price:: 20 EUR" is a real fact.
    text = text.replace(/^([ \t]*)([^\n:]{1,80})::[ \t]*/gm, "$1$2: ");

    // Code blocks keep their body, lose the fence and the language name.
    text = text.replace(/^[ \t]*```[^\n]*\n?/gm, "");

    // Math carries nothing a chatbot can say.
    text = text.replace(/\$\$[\s\S]*?\$\$/g, "");

    // Images.
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");

    // Aliases: [label]([[Page]]) and [label](((uid))) keep the label.
    text = text.replace(/\[([^\]]+)\]\(\[\[[^\]]*\]\]\)/g, "$1");
    text = text.replace(/\[([^\]]+)\]\(\(\([^)]*\)\)\)/g, "$1");

    // Tags: #[[multi word]] and #tag keep the word. A line that is only tags
    // is metadata, so it goes.
    text = text.replace(/^[ \t]*(?:#(?:\[\[[^\]]+\]\]|[\w/-]+)[ \t]*)+\r?\n?/gm, "");
    text = text.replace(/#\[\[([^\]]+)\]\]/g, "$1");
    text = text.replace(/(^|[\s(])#([\w/-]+)/g, "$1$2");

    // Page links: [[page]] -> page. Nested links unwrap from the inside out.
    let previous = "";
    while (previous !== text) {
        previous = text;
        text = text.replace(/\[\[([^[\]]+)\]\]/g, "$1");
    }

    // A block reference that could not be resolved is an id, not a word.
    text = text.replace(BLOCK_REF, "");

    // Markdown links keep the label and the address, so an answer can point
    // the visitor somewhere.
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)[^)]*\)/g, "$1 ($2)");
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

    // Quotes, horizontal rules.
    text = text.replace(/^(\s*)>\s?/gm, "$1");
    text = text.replace(/^[ \t]*-{3,}[ \t]*\r?\n?/gm, "");

    // Bold, italic, highlight, strike, inline code.
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
    text = text.replace(/__([^_\n]+)__/g, "$1");
    text = text.replace(/\^\^([^^\n]+)\^\^/g, "$1");
    text = text.replace(/~~([^~\n]+)~~/g, "$1");
    text = text.replace(/`([^`\n]+)`/g, "$1");

    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/[ \t]*\n[ \t]*/g, "\n");
    // A line that held only markup is empty now.
    text = text
        .split("\n")
        .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
        .join("\n");
    return text.trim();
}

/** The title is the page's name as the writer typed it. */
export function pageText(blocks: BlockLike[], title: string): PageText {
    return { title: (title || "").trim(), text: roamToText(flattenBlocks(blocks)) };
}

/** What goes into the knowledge base entry. */
export function knowledgeContent(page: PageText): string {
    return `${page.title}\n\n${page.text}`;
}

// A small, fast, non-cryptographic hash: the map only needs to know whether
// the page changed since it was last sent.
export function hashText(text: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}
