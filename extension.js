// src/api.ts
var DEFAULT_ORIGIN = "https://asyntai.com";
var ApiError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
};
var ASK_MARKER = "roam_ask_";
function newAskSession() {
  return `${ASK_MARKER}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function isOwnQuestion(sessionId) {
  return typeof sessionId === "string" && sessionId.includes(ASK_MARKER);
}
function query(params) {
  const search = new URLSearchParams();
  for (const name of Object.keys(params)) {
    const value = params[name];
    if (value !== void 0 && value !== null && value !== "") {
      search.set(name, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
var AsyntaiApi = class {
  constructor(transport2, apiKey, origin = () => DEFAULT_ORIGIN) {
    this.transport = transport2;
    this.apiKey = apiKey;
    this.origin = origin;
  }
  async request(path, method = "GET", body) {
    const key = this.apiKey().trim();
    if (!key) {
      throw new ApiError("Add your Asyntai API key in Settings > Asyntai AI Chatbot.", 401);
    }
    const headers = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    };
    const req = {
      url: this.origin().replace(/\/+$/, "") + path,
      method,
      headers
    };
    if (body !== void 0) {
      headers["Content-Type"] = "application/json";
      req.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await this.transport(req);
    } catch {
      throw new ApiError("Asyntai did not answer. Check your connection.", 0);
    }
    let data = {};
    try {
      data = res.text ? JSON.parse(res.text) : {};
    } catch {
      data = {};
    }
    if (res.status === 401) {
      throw new ApiError("Asyntai does not accept this API key.", 401);
    }
    if (res.status === 403) {
      throw new ApiError(
        typeof data.error === "string" ? data.error : "The Asyntai API needs the Starter plan or higher.",
        403
      );
    }
    if (res.status < 200 || res.status >= 300 || data.success === false) {
      const message = typeof data.error === "string" ? data.error : `Asyntai answered with status ${res.status}.`;
      throw new ApiError(message, res.status);
    }
    return data;
  }
  async account() {
    const data = await this.request("/api/v1/account/");
    return data.account;
  }
  async sessions(limit = 30) {
    const data = await this.request(`/api/v1/sessions/${query({ limit })}`);
    const list = data.sessions || [];
    return list.filter((s) => !isOwnQuestion(s.session_id));
  }
  async conversation(sessionId) {
    const data = await this.request(`/api/v1/conversations/${query({ session_id: sessionId, limit: 100 })}`);
    return data.messages || [];
  }
  async leads(limit = 30) {
    const data = await this.request(`/api/v1/leads/${query({ limit })}`);
    return data.leads || [];
  }
  async chat(message, sessionId) {
    const data = await this.request("/api/v1/chat/", "POST", { message, session_id: sessionId });
    return String(data.response || "");
  }
  async addText(title, content) {
    const data = await this.request("/api/v1/knowledge/text/", "POST", { title, content });
    const id = data.id;
    if (typeof id !== "string" || !id) {
      throw new ApiError("Asyntai stored the note but returned no id.", 500);
    }
    return id;
  }
  // 404 counts as done: the entry is already gone on the Asyntai side.
  async deleteEntry(id) {
    try {
      await this.request(`/api/v1/knowledge/${encodeURIComponent(id)}/`, "DELETE");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return;
      }
      throw err;
    }
  }
  async knowledge(limit = 100) {
    const data = await this.request(`/api/v1/knowledge/${query({ limit })}`);
    return data.entries || [];
  }
};

// src/text.ts
function sortBlocks(blocks) {
  return [...blocks || []].filter(Boolean).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
function flattenBlocks(blocks, depth = 0) {
  const lines = [];
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
var BLOCK_REF = /\(\(([A-Za-z0-9_-]{9})\)\)/g;
function blockRefs(text) {
  const out = [];
  for (const match of (text || "").matchAll(BLOCK_REF)) {
    if (!out.includes(match[1])) {
      out.push(match[1]);
    }
  }
  return out;
}
function resolveBlockRefs(text, lookup) {
  return (text || "").replace(BLOCK_REF, (_all, uid) => lookup[uid] ?? "");
}
function stripWidgets(text) {
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
      out += text.slice(start);
      break;
    }
    i = j + 1;
  }
  return out;
}
function roamToText(body) {
  let text = (body || "").replace(/\r\n/g, "\n");
  text = text.replace(/\{\{\s*\[\[(?:TODO|DONE)\]\]\s*\}\}\s*/g, "");
  text = stripWidgets(text);
  text = text.replace(/^([ \t]*)([^\n:]{1,80})::[ \t]*/gm, "$1$2: ");
  text = text.replace(/^[ \t]*```[^\n]*\n?/gm, "");
  text = text.replace(/\$\$[\s\S]*?\$\$/g, "");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]+)\]\(\[\[[^\]]*\]\]\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\(\(\([^)]*\)\)\)/g, "$1");
  text = text.replace(/^[ \t]*(?:#(?:\[\[[^\]]+\]\]|[\w/-]+)[ \t]*)+\r?\n?/gm, "");
  text = text.replace(/#\[\[([^\]]+)\]\]/g, "$1");
  text = text.replace(/(^|[\s(])#([\w/-]+)/g, "$1$2");
  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(/\[\[([^[\]]+)\]\]/g, "$1");
  }
  text = text.replace(BLOCK_REF, "");
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)[^)]*\)/g, "$1 ($2)");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/^(\s*)>\s?/gm, "$1");
  text = text.replace(/^[ \t]*-{3,}[ \t]*\r?\n?/gm, "");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  text = text.replace(/__([^_\n]+)__/g, "$1");
  text = text.replace(/\^\^([^^\n]+)\^\^/g, "$1");
  text = text.replace(/~~([^~\n]+)~~/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/[ \t]*\n[ \t]*/g, "\n");
  text = text.split("\n").filter((line, i, all) => line !== "" || i > 0 && all[i - 1] !== "").join("\n");
  return text.trim();
}
function pageText(blocks, title) {
  return { title: (title || "").trim(), text: roamToText(flattenBlocks(blocks)) };
}
function knowledgeContent(page) {
  return `${page.title}

${page.text}`;
}
function hashText(text) {
  let h1 = 3735928559;
  let h2 = 1103547991;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
  h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

// src/graph.ts
function isJournalUid(uid) {
  return /^\d{2}-\d{2}-\d{4}$/.test(uid || "");
}
function field(entity, name) {
  if (!entity) {
    return void 0;
  }
  const value = entity[`:${name}`] ?? entity[name];
  return value;
}
var TREE = "[:block/string :block/order :block/heading {:block/children ...}]";
var PAGE_TREE = `[:node/title {:block/children ${TREE}}]`;
function toBlock(entity) {
  const children = field(entity, "block/children") || [];
  return {
    string: field(entity, "block/string") || "",
    order: field(entity, "block/order") ?? 0,
    heading: field(entity, "block/heading"),
    children: children.map(toBlock)
  };
}
function walk(blocks, visit) {
  for (const block of blocks) {
    visit(block);
    walk(block.children || [], visit);
  }
}
var REF_DEPTH = 3;
var RoamGraph = class {
  constructor(alpha) {
    this.alpha = alpha;
  }
  q(query2, ...args) {
    const reader = this.alpha.data.async?.q ?? this.alpha.data.q;
    return Promise.resolve(reader.call(this.alpha.data.async ?? this.alpha.data, query2, ...args));
  }
  pull(pattern, eid) {
    const reader = this.alpha.data.async?.pull ?? this.alpha.data.pull;
    return Promise.resolve(reader.call(this.alpha.data.async ?? this.alpha.data, pattern, eid));
  }
  async pages() {
    const rows = await this.q("[:find ?uid ?title :where [?p :node/title ?title] [?p :block/uid ?uid]]");
    return (rows || []).filter((row) => row && row[0] && row[1]).map(([uid, title]) => ({ uid, title, journal: isJournalUid(uid) }));
  }
  async page(uid) {
    const entity = await this.pull("[:node/title :block/uid]", [":block/uid", uid]);
    const title = field(entity, "node/title");
    if (!title) {
      return null;
    }
    return { uid, title, journal: isJournalUid(uid) };
  }
  /** The newest edit time of every page: the page itself or any block on it. */
  async editTimes() {
    const out = {};
    const note = (rows) => {
      for (const row of rows || []) {
        const [uid, time] = row;
        if (uid && typeof time === "number" && time > (out[uid] || 0)) {
          out[uid] = time;
        }
      }
    };
    note(
      await this.q(
        "[:find ?uid (max ?t) :where [?p :node/title] [?p :block/uid ?uid] [?b :block/page ?p] [?b :edit/time ?t]]"
      )
    );
    note(await this.q("[:find ?uid ?t :where [?p :node/title] [?p :block/uid ?uid] [?p :edit/time ?t]]"));
    return out;
  }
  async blocks(uid) {
    const entity = await this.pull(PAGE_TREE, [":block/uid", uid]);
    const blocks = (field(entity, "block/children") || []).map(toBlock);
    await this.resolveRefs(blocks);
    return blocks;
  }
  /** Swaps every ((uid)) for the text of the block it points at. */
  async resolveRefs(blocks) {
    const raw = {};
    let wanted = /* @__PURE__ */ new Set();
    walk(blocks, (block) => blockRefs(block.string || "").forEach((ref) => wanted.add(ref)));
    for (let depth = 0; depth < REF_DEPTH && wanted.size; depth++) {
      const next = /* @__PURE__ */ new Set();
      for (const ref of wanted) {
        let text = "";
        try {
          text = field(await this.pull("[:block/string]", [":block/uid", ref]), "block/string") || "";
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
    const resolved = {};
    const resolve = (ref, depth) => {
      if (ref in resolved) {
        return resolved[ref];
      }
      if (!(ref in raw) || depth >= REF_DEPTH) {
        return "";
      }
      resolved[ref] = "";
      const text = raw[ref].replace(/\(\(([A-Za-z0-9_-]{9})\)\)/g, (_all, inner) => resolve(inner, depth + 1));
      resolved[ref] = text;
      return text;
    };
    const lookup = {};
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
  async currentPage() {
    const getter = this.alpha.ui.mainWindow?.getOpenPageOrBlockUid;
    if (!getter) {
      return null;
    }
    const uid = await Promise.resolve(getter.call(this.alpha.ui.mainWindow));
    if (!uid) {
      return null;
    }
    const entity = await this.pull("[:node/title {:block/page [:block/uid :node/title]}]", [":block/uid", uid]);
    const title = field(entity, "node/title");
    if (title) {
      return { uid, title, journal: isJournalUid(uid) };
    }
    const page = field(entity, "block/page");
    const pageUid = field(page, "block/uid");
    const pageTitle = field(page, "node/title");
    if (pageUid && pageTitle) {
      return { uid: pageUid, title: pageTitle, journal: isJournalUid(pageUid) };
    }
    return null;
  }
  /** The uid of the main window's page or zoomed block, for appending. */
  async openUid() {
    const getter = this.alpha.ui.mainWindow?.getOpenPageOrBlockUid;
    if (!getter) {
      return null;
    }
    return await Promise.resolve(getter.call(this.alpha.ui.mainWindow)) || null;
  }
  focusedBlockUid() {
    try {
      return this.alpha.ui.getFocusedBlock?.()?.["block-uid"] || null;
    } catch {
      return null;
    }
  }
  async exists(uid) {
    const entity = await this.pull("[:block/uid]", [":block/uid", uid]);
    return Boolean(field(entity, "block/uid"));
  }
  /** Adds one block at the end of a page or under a block. */
  async append(parentUid, text) {
    await Promise.resolve(
      this.alpha.data.block.create({ location: { "parent-uid": parentUid, order: "last" }, block: { string: text } })
    );
  }
  async pageUidByTitle(title) {
    const entity = await this.pull("[:block/uid]", [":node/title", title]);
    return field(entity, "block/uid") || null;
  }
  /** Makes a page, or reuses the page with that title, and fills it with blocks. */
  async createPage(title, lines) {
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
        this.alpha.data.block.create({ location: { "parent-uid": uid, order: "last" }, block: { string: line } })
      );
    }
    return uid;
  }
};

// src/store.ts
var MAP_KEY = "syncMapJson";
function serializeMap(map) {
  return JSON.stringify(map);
}
function parseMap(stored) {
  if (typeof stored === "string" && stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
    }
  }
  return {};
}

// src/styles.ts
var STYLE_ID = "asyntai-ai-chatbot-style";
var CSS = `
.asyntai-host { position: fixed; top: 50px; right: 16px; bottom: 16px; width: 380px; max-width: calc(100vw - 32px);
  z-index: 30; display: none; }
.asyntai-host.asyntai-open { display: block; }
.asyntai-panel { height: 100%; display: flex; flex-direction: column; background: #fff; color: #111;
  border: 1px solid #d8d8d8; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.12);
  font-size: 14px; line-height: 1.45; overflow: hidden; }
.asyntai-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eee; }
.asyntai-title { font-weight: 600; }
.asyntai-tabs { display: flex; gap: 4px; margin-left: 8px; flex: 1; }
.asyntai-tab { background: none; border: 1px solid transparent; border-radius: 6px; padding: 3px 9px; cursor: pointer; color: #444; }
.asyntai-tab.asyntai-on { border-color: #111; color: #111; }
.asyntai-close { background: none; border: none; font-size: 20px; line-height: 1; cursor: pointer; color: #666; }
.asyntai-body { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.asyntai-log { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.asyntai-msg { border: 1px solid #eee; border-radius: 6px; padding: 8px 10px; }
.asyntai-msg.asyntai-user { background: #f6f6f6; }
.asyntai-who { font-size: 12px; color: #666; margin-bottom: 2px; }
.asyntai-text { white-space: pre-wrap; word-wrap: break-word; }
.asyntai-form { display: flex; flex-direction: column; gap: 6px; }
.asyntai-input { width: 100%; box-sizing: border-box; resize: vertical; border: 1px solid #ccc; border-radius: 6px;
  padding: 7px 9px; font: inherit; }
.asyntai-row { display: flex; align-items: center; gap: 10px; }
.asyntai-send { background: #111; color: #fff; border: none; border-radius: 6px; padding: 6px 14px; cursor: pointer; }
.asyntai-send:disabled { opacity: .6; cursor: default; }
.asyntai-link { background: none; border: none; padding: 0; color: #111; text-decoration: underline; cursor: pointer;
  font-size: 13px; align-self: flex-start; }
.asyntai-note { color: #666; }
.asyntai-error { color: #b00020; }
.asyntai-item { border: 1px solid #eee; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
.asyntai-item:hover { border-color: #bbb; }
.asyntai-item-title { font-weight: 500; }
.asyntai-item-meta { font-size: 12px; color: #666; margin-top: 2px; }
.bp3-dark .asyntai-panel { background: #1e1e1e; color: #eee; border-color: #333; }
.bp3-dark .asyntai-msg, .bp3-dark .asyntai-item, .bp3-dark .asyntai-head { border-color: #333; }
.bp3-dark .asyntai-msg.asyntai-user { background: #2a2a2a; }
.bp3-dark .asyntai-tab.asyntai-on, .bp3-dark .asyntai-link { border-color: #eee; color: #eee; }
.bp3-dark .asyntai-send { background: #eee; color: #111; }
.bp3-dark .asyntai-input { background: #2a2a2a; color: #eee; border-color: #444; }
`;

// src/sync.ts
var MIN_LENGTH = 120;
var SAVED_CHATS_NAMESPACE = "asyntai chats";
function parseNamespaces(raw) {
  const out = [];
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
function inNamespace(name, namespace) {
  if (namespace === "" || namespace === "/") {
    return true;
  }
  return name === namespace || name.startsWith(namespace + "/");
}
function shouldSync(page, options) {
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
  const namespaces = options.namespaces.filter((n) => n !== void 0);
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
var SyncEngine = class {
  constructor(api, graph, map, save, options) {
    // Every write runs one at a time. Two runs side by side (the watcher
    // during "send all", or "send all" pressed twice) both saw a page as
    // unsent and both added it, so Asyntai held the page twice.
    this.queue = Promise.resolve();
    this.api = api;
    this.graph = graph;
    this.map = map;
    this.save = save;
    this.options = options;
  }
  entries() {
    return this.map;
  }
  count() {
    return Object.keys(this.map).length;
  }
  isSynced(uid) {
    return Boolean(this.map[uid]?.kb);
  }
  /** When a page was last sent, 0 if never. */
  sentAt(uid) {
    return this.map[uid]?.sent || 0;
  }
  wanted(page) {
    return shouldSync(page, this.options());
  }
  exclusive(work) {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => void 0);
    return run;
  }
  /**
   * Send one page. A page already in the knowledge base is replaced: the
   * new entry goes up first, then the old one is removed, so the chatbot
   * never has a gap.
   */
  push(page, blocks) {
    return this.exclusive(() => this.pushNow(page, blocks));
  }
  /** Remove a page from the knowledge base, if it was ever sent. */
  remove(uid) {
    return this.exclusive(() => this.removeNow(uid));
  }
  async pushNow(page, blocks) {
    const tree = blocks === void 0 ? await this.graph.blocks(page.uid) : blocks;
    const parsed = pageText(tree, page.title);
    if (parsed.text.length < MIN_LENGTH) {
      await this.removeNow(page.uid);
      return { ok: true, skipped: true, message: "Page is too short to send." };
    }
    const body = knowledgeContent(parsed);
    const hash = hashText(body);
    const known = this.map[page.uid];
    if (known && known.hash === hash && known.kb) {
      known.sent = Date.now();
      await this.save(this.map);
      return { ok: true, skipped: true, message: "Page is unchanged." };
    }
    let kb;
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
      }
    }
    return { ok: true, skipped: false, message: "Page sent to Asyntai." };
  }
  async removeNow(uid) {
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
  syncAll(onProgress) {
    return this.exclusive(() => this.syncAllNow(onProgress));
  }
  async syncAllNow(onProgress) {
    const result = { sent: 0, skipped: 0, removed: 0, failed: 0, errors: [] };
    const all = await this.graph.pages();
    const pages2 = all.filter((p) => this.wanted(p));
    const present = new Set(pages2.map((p) => p.uid));
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
    for (const page of pages2) {
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
      onProgress?.(done, pages2.length);
    }
    return result;
  }
  /** Remove every synced page from the knowledge base. */
  removeAll() {
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
};
function errorText(err) {
  if (err instanceof ApiError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// src/ui.ts
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== void 0) {
    node.textContent = text;
  }
  return node;
}
function chatTitle(session) {
  const date = (session.first_message_at || session.last_message_at || "").slice(0, 10);
  const words = (session.first_message || session.session_id || "chat").replace(/[\[\]#/{}()^*_~`|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return [date, words || session.session_id].filter(Boolean).join(" ");
}
function when(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}
var Panel = class {
  constructor(api, hooks, mount) {
    this.tab = "ask";
    this.askSession = newAskSession();
    this.askLog = [];
    this.busy = false;
    this.api = api;
    this.hooks = hooks;
    this.root = el("div", "asyntai-panel");
    const head = el("div", "asyntai-head");
    head.appendChild(el("div", "asyntai-title", "Asyntai"));
    const tabs = el("div", "asyntai-tabs");
    const make = (tab, label) => {
      const button = el("button", "asyntai-tab", label);
      button.addEventListener("click", () => this.show(tab));
      tabs.appendChild(button);
      return button;
    };
    this.tabButtons = {
      ask: make("ask", "Ask"),
      chats: make("chats", "Chats"),
      leads: make("leads", "Leads")
    };
    head.appendChild(tabs);
    const close = el("button", "asyntai-close", "\xD7");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.hooks.close());
    head.appendChild(close);
    this.body = el("div", "asyntai-body");
    this.root.appendChild(head);
    this.root.appendChild(this.body);
    mount.appendChild(this.root);
    this.show("ask");
  }
  show(tab) {
    this.tab = tab;
    for (const name of Object.keys(this.tabButtons)) {
      this.tabButtons[name].classList.toggle("asyntai-on", name === tab);
    }
    if (tab === "ask") {
      this.renderAsk();
    } else if (tab === "chats") {
      void this.renderChats();
    } else {
      void this.renderLeads();
    }
  }
  /** A fresh question thread, so an old topic never colours a new answer. */
  newThread() {
    this.askSession = newAskSession();
    this.askLog = [];
    if (this.tab === "ask") {
      this.renderAsk();
    }
  }
  clear() {
    this.body.textContent = "";
    return this.body;
  }
  note(parent, text, kind = "asyntai-note") {
    parent.appendChild(el("div", kind, text));
  }
  renderAsk(prefill = "") {
    const body = this.clear();
    const log = el("div", "asyntai-log");
    if (this.askLog.length === 0) {
      this.note(log, "Ask about the pages you sent to Asyntai.");
    }
    for (const message of this.askLog) {
      const row2 = el("div", `asyntai-msg asyntai-${message.role}`);
      row2.appendChild(el("div", "asyntai-who", message.role === "user" ? "You" : "Asyntai"));
      row2.appendChild(el("div", "asyntai-text", message.content));
      if (message.role === "assistant") {
        const insert = el("button", "asyntai-link", "Insert into page");
        insert.addEventListener("click", () => {
          void this.hooks.insert(message.content);
        });
        row2.appendChild(insert);
      }
      log.appendChild(row2);
    }
    body.appendChild(log);
    const form = el("div", "asyntai-form");
    const input = el("textarea", "asyntai-input");
    input.rows = 2;
    input.placeholder = "Ask a question";
    input.value = prefill;
    const send = el("button", "asyntai-send", this.busy ? "Asking\u2026" : "Ask");
    send.disabled = this.busy;
    const submit = async () => {
      const question = input.value.trim();
      if (!question || this.busy) {
        return;
      }
      this.busy = true;
      this.askLog.push({ role: "user", content: question, timestamp: "" });
      this.renderAsk();
      try {
        const answer = await this.api.chat(question, this.askSession);
        this.askLog.push({ role: "assistant", content: answer, timestamp: "" });
      } catch (err) {
        this.askLog.push({ role: "assistant", content: errorText(err), timestamp: "" });
      }
      this.busy = false;
      this.renderAsk();
      log.scrollTop = log.scrollHeight;
    };
    send.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    });
    const reset = el("button", "asyntai-link", "New thread");
    reset.addEventListener("click", () => this.newThread());
    form.appendChild(input);
    const row = el("div", "asyntai-row");
    row.appendChild(send);
    row.appendChild(reset);
    form.appendChild(row);
    body.appendChild(form);
    log.scrollTop = log.scrollHeight;
    if (!this.busy) {
      input.focus();
    }
  }
  /** Opens the Ask tab with the question already typed. */
  askAbout(question) {
    this.tab = "ask";
    for (const name of Object.keys(this.tabButtons)) {
      this.tabButtons[name].classList.toggle("asyntai-on", name === "ask");
    }
    this.renderAsk(question);
  }
  async renderChats() {
    const body = this.clear();
    this.note(body, "Loading\u2026");
    let sessions;
    try {
      sessions = await this.api.sessions(30);
    } catch (err) {
      this.clear();
      this.note(this.body, errorText(err), "asyntai-error");
      return;
    }
    if (this.tab !== "chats") {
      return;
    }
    const list = this.clear();
    if (sessions.length === 0) {
      this.note(list, "No website chats yet.");
      return;
    }
    for (const session of sessions) {
      const item = el("div", "asyntai-item");
      item.appendChild(el("div", "asyntai-item-title", session.first_message || session.session_id));
      const meta = [when(session.last_message_at), session.country, `${session.message_count} messages`].filter(Boolean).join(" \xB7 ");
      item.appendChild(el("div", "asyntai-item-meta", meta));
      item.addEventListener("click", () => void this.openChat(session));
      list.appendChild(item);
    }
  }
  async openChat(session) {
    const body = this.clear();
    const back = el("button", "asyntai-link", "\u2190 Back to chats");
    back.addEventListener("click", () => void this.renderChats());
    body.appendChild(back);
    this.note(body, "Loading\u2026");
    let messages;
    try {
      messages = await this.api.conversation(session.session_id);
    } catch (err) {
      this.clear();
      this.body.appendChild(back);
      this.note(this.body, errorText(err), "asyntai-error");
      return;
    }
    const view = this.clear();
    view.appendChild(back);
    const save = el("button", "asyntai-link", "Save as page");
    save.title = "Saved chats go under Asyntai chats/ and are never sent back to Asyntai.";
    save.addEventListener("click", () => {
      const lines = messages.map((m) => `${m.role === "user" ? "Visitor" : "Asyntai"}: ${m.content}`);
      const title = `Asyntai chats/${chatTitle(session)}`;
      void this.hooks.saveAsPage(title, lines.join("\n"));
    });
    view.appendChild(save);
    const log = el("div", "asyntai-log");
    for (const message of messages) {
      const row = el("div", `asyntai-msg asyntai-${message.role}`);
      row.appendChild(el("div", "asyntai-who", message.role === "user" ? "Visitor" : "Asyntai"));
      row.appendChild(el("div", "asyntai-text", message.content));
      log.appendChild(row);
    }
    view.appendChild(log);
  }
  async renderLeads() {
    const body = this.clear();
    this.note(body, "Loading\u2026");
    let leads;
    try {
      leads = await this.api.leads(30);
    } catch (err) {
      this.clear();
      this.note(this.body, errorText(err), "asyntai-error");
      return;
    }
    if (this.tab !== "leads") {
      return;
    }
    const list = this.clear();
    if (leads.length === 0) {
      this.note(list, "No leads yet.");
      return;
    }
    for (const lead of leads) {
      const item = el("div", "asyntai-item");
      item.appendChild(el("div", "asyntai-item-title", lead.email || lead.phone || lead.session_id));
      const meta = [when(lead.started_at), lead.phone && lead.email ? lead.phone : "", lead.page_url].filter(Boolean).join(" \xB7 ");
      item.appendChild(el("div", "asyntai-item-meta", meta));
      list.appendChild(item);
    }
  }
};

// src/index.ts
var KEY = {
  apiKey: "apiKey",
  namespaces: "namespaces",
  excluded: "excluded",
  journals: "journals",
  autoSync: "autoSync",
  origin: "origin"
};
var WATCH_INTERVAL_MS = 15e3;
var QUIET_MS = 4e3;
var COMMANDS = {
  open: "Asyntai: open panel",
  sendPage: "Asyntai: send this page",
  removePage: "Asyntai: remove this page",
  sendAll: "Asyntai: send all pages",
  removeAll: "Asyntai: remove all pages",
  checkKey: "Asyntai: check API key"
};
var SLASH_LABEL = "Asyntai ask";
var transport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  return { status: res.status, text: await res.text() };
};
function questionFromBlock(text, indexes) {
  let value = text || "";
  if (Array.isArray(indexes) && indexes.length === 2 && indexes[0] <= indexes[1] && indexes[1] <= value.length) {
    const start = value[indexes[0] - 1] === "/" ? indexes[0] - 1 : indexes[0];
    value = value.slice(0, start) + value.slice(indexes[1]);
  } else {
    value = value.replace(/\/[^/\n]*$/, "");
  }
  return value.trim();
}
var runtime = null;
var TOAST_BOX_ID = "asyntai-ai-chatbot-toasts";
function toast(message, intent = "none") {
  let box = document.getElementById(TOAST_BOX_ID);
  if (!box) {
    box = document.createElement("div");
    box.id = TOAST_BOX_ID;
    box.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:40;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;";
    document.body.appendChild(box);
  }
  const item = document.createElement("div");
  item.className = "asyntai-toast";
  item.textContent = message;
  item.setAttribute("role", "status");
  item.style.cssText = "padding:8px 14px;border-radius:6px;font-size:14px;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.18);max-width:520px;text-align:center;background:" + (intent === "danger" ? "#b00020" : intent === "warning" ? "#8a5a00" : "#111");
  box.appendChild(item);
  while (box.children.length > 3) {
    box.firstElementChild?.remove();
  }
  setTimeout(() => item.remove(), 4500);
}
function pages(count) {
  return `${count} ${count === 1 ? "page" : "pages"}`;
}
async function onload({ extensionAPI }) {
  const alpha = window.roamAlphaAPI;
  const settings = extensionAPI.settings;
  const text = (key) => {
    const value = settings.get(key);
    return typeof value === "string" ? value : "";
  };
  const flag = (key, fallback) => {
    const value = settings.get(key);
    return typeof value === "boolean" ? value : fallback;
  };
  if (settings.get(KEY.autoSync) == null) {
    await Promise.resolve(settings.set(KEY.autoSync, true));
  }
  if (settings.get(KEY.journals) == null) {
    await Promise.resolve(settings.set(KEY.journals, false));
  }
  if (!text(KEY.origin)) {
    await Promise.resolve(settings.set(KEY.origin, DEFAULT_ORIGIN));
  }
  await Promise.resolve(
    settings.panel.create({
      tabTitle: "Asyntai AI Chatbot",
      settings: [
        {
          id: KEY.apiKey,
          name: "Asyntai API key",
          description: "Settings \u2192 API in your Asyntai dashboard. The API needs the Starter plan or higher.",
          action: { type: "input", placeholder: "asyntai_..." }
        },
        {
          id: KEY.namespaces,
          name: "Pages to send",
          description: 'Page title prefixes, comma separated, for example "Docs" sends "Docs/Refund policy". Type "/" to send every page. Empty sends nothing.',
          action: { type: "input", placeholder: "Docs, Help center" }
        },
        {
          id: KEY.excluded,
          name: "Pages to leave out",
          description: "Prefixes that stay out even when a parent is sent.",
          action: { type: "input", placeholder: "Docs/Drafts" }
        },
        {
          id: KEY.journals,
          name: "Send daily notes",
          description: "Daily notes are usually private, so they stay out unless you turn this on.",
          action: { type: "switch" }
        },
        {
          id: KEY.autoSync,
          name: "Send changes automatically",
          description: "Send a page to Asyntai a few seconds after you stop editing it.",
          action: { type: "switch" }
        },
        {
          id: KEY.origin,
          name: "Asyntai address",
          description: "Leave this as it is unless Asyntai support asks you to change it.",
          action: { type: "input", placeholder: DEFAULT_ORIGIN }
        }
      ]
    })
  );
  const api = new AsyntaiApi(transport, () => text(KEY.apiKey), () => text(KEY.origin) || DEFAULT_ORIGIN);
  const graph = new RoamGraph(alpha);
  const options = () => ({
    namespaces: parseNamespaces(text(KEY.namespaces)),
    excluded: parseNamespaces(text(KEY.excluded)),
    journals: flag(KEY.journals, false)
  });
  const saveMap = async (map) => {
    await Promise.resolve(settings.set(MAP_KEY, serializeMap(map)));
  };
  const engine = new SyncEngine(api, graph, parseMap(settings.get(MAP_KEY)), saveMap, options);
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  const host = document.createElement("div");
  host.className = "asyntai-host";
  host.id = "asyntai-ai-chatbot-panel";
  document.body.appendChild(host);
  let insertTarget = null;
  const close = () => {
    host.classList.remove("asyntai-open");
  };
  const panel = new Panel(
    api,
    {
      insert: async (answer) => {
        try {
          let parent = insertTarget && await graph.exists(insertTarget) ? insertTarget : null;
          if (!parent) {
            parent = await graph.openUid();
          }
          if (!parent) {
            toast("Open a page first.", "warning");
            return;
          }
          await graph.append(parent, answer);
          toast("Answer added.", "success");
        } catch (err) {
          toast(errorText(err), "danger");
        }
      },
      saveAsPage: async (title, body) => {
        try {
          await graph.createPage(title, body.split("\n"));
          toast(`Chat saved as [[${title}]].`, "success");
        } catch (err) {
          toast(errorText(err), "danger");
        }
      },
      close
    },
    host
  );
  const open = (target) => {
    insertTarget = target !== void 0 ? target : graph.focusedBlockUid();
    host.classList.add("asyntai-open");
  };
  const toggle = () => {
    if (host.classList.contains("asyntai-open")) {
      close();
    } else {
      open();
    }
  };
  const onKey = (event) => {
    if (event.key === "Escape" && host.classList.contains("asyntai-open")) {
      close();
    }
  };
  document.addEventListener("keydown", onKey);
  const button = document.createElement("span");
  button.className = "bp3-button bp3-minimal bp3-small bp3-icon-chat asyntai-topbar-button";
  button.setAttribute("title", "Asyntai AI Chatbot");
  button.setAttribute("role", "button");
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", toggle);
  const spacer = document.createElement("div");
  spacer.className = "rm-topbar__spacer-sm asyntai-topbar-spacer";
  const placeButton = () => {
    if (button.isConnected) {
      return true;
    }
    const bar = document.querySelector(".rm-topbar");
    if (!bar) {
      return false;
    }
    bar.appendChild(spacer);
    bar.appendChild(button);
    return true;
  };
  const barTimer = setInterval(placeButton, 2e3);
  placeButton();
  const pushCurrent = async () => {
    const page = await graph.currentPage();
    if (!page) {
      toast("Open a page first.", "warning");
      return;
    }
    const result = await engine.push(page);
    toast(result.message, result.ok ? "success" : "danger");
  };
  const removeCurrent = async () => {
    const page = await graph.currentPage();
    if (!page) {
      toast("Open a page first.", "warning");
      return;
    }
    if (!engine.isSynced(page.uid)) {
      toast("This page is not in Asyntai.", "warning");
      return;
    }
    const ok = await engine.remove(page.uid);
    toast(ok ? "Page removed from Asyntai." : "Asyntai did not remove the page.", ok ? "success" : "danger");
  };
  const sendAll = async () => {
    toast("Sending pages to Asyntai\u2026");
    const result = await engine.syncAll();
    const parts = [`${result.sent} sent`, `${result.skipped} skipped`];
    if (result.removed) {
      parts.push(`${result.removed} removed`);
    }
    if (result.failed) {
      parts.push(`${result.failed} failed`);
    }
    toast(parts.join(", "), result.failed ? "warning" : "success");
    if (result.errors.length) {
      console.error("[asyntai]", result.errors);
    }
  };
  const removeAll = async () => {
    const removed = await engine.removeAll();
    toast(`${pages(removed)} removed from Asyntai.`, "success");
  };
  const checkKey = async () => {
    try {
      const account = await api.account();
      toast(`Connected as ${account.email} on the ${account.plan} plan.`, "success");
    } catch (err) {
      toast(errorText(err), "danger");
    }
  };
  const palette = extensionAPI.ui?.commandPalette;
  const commands = [
    [COMMANDS.open, () => open()],
    [COMMANDS.sendPage, () => void pushCurrent()],
    [COMMANDS.removePage, () => void removeCurrent()],
    [COMMANDS.sendAll, () => void sendAll()],
    [COMMANDS.removeAll, () => void removeAll()],
    [COMMANDS.checkKey, () => void checkKey()]
  ];
  for (const [label, callback] of commands) {
    await Promise.resolve(palette?.addCommand({ label, callback }));
  }
  const slash = extensionAPI.ui?.slashCommand;
  await Promise.resolve(
    slash?.addCommand({
      label: SLASH_LABEL,
      callback: (context) => {
        const active = document.activeElement;
        const value = active && active.tagName === "TEXTAREA" ? active.value : "";
        const question = questionFromBlock(value, context?.indexes);
        open(context?.["block-uid"] || graph.focusedBlockUid());
        panel.askAbout(question);
        return "";
      }
    })
  );
  const startedAt = Date.now();
  let busy = false;
  const tick = async () => {
    if (busy || !flag(KEY.autoSync, true) || !text(KEY.apiKey).trim()) {
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return;
    }
    busy = true;
    try {
      const times = await graph.editTimes();
      const now = Date.now();
      for (const [uid, edited] of Object.entries(times)) {
        if (edited <= Math.max(engine.sentAt(uid), startedAt) || now - edited < QUIET_MS) {
          continue;
        }
        const page = await graph.page(uid);
        if (!page) {
          continue;
        }
        if (engine.wanted(page)) {
          await engine.push(page);
        } else if (engine.isSynced(uid)) {
          await engine.remove(uid);
        }
      }
      for (const uid of Object.keys(engine.entries())) {
        if (!(uid in times) && !await graph.exists(uid)) {
          await engine.remove(uid);
        }
      }
    } catch (err) {
      console.error("[asyntai] auto sync", err);
    } finally {
      busy = false;
    }
  };
  const watchTimer = setInterval(() => void tick(), WATCH_INTERVAL_MS);
  runtime = {
    stop: () => {
      clearInterval(watchTimer);
      clearInterval(barTimer);
      document.removeEventListener("keydown", onKey);
      button.remove();
      spacer.remove();
      host.remove();
      document.getElementById(TOAST_BOX_ID)?.remove();
      style.remove();
      for (const [label] of commands) {
        try {
          void palette?.removeCommand?.({ label });
        } catch {
        }
      }
      try {
        void slash?.removeCommand?.({ label: SLASH_LABEL });
      } catch {
      }
    }
  };
  const testHooks = window;
  if (testHooks.__asyntaiTest === true) {
    testHooks.__asyntaiRoam = { engine, graph, tick, panel };
  }
  console.log("[asyntai] extension ready");
}
function onunload() {
  runtime?.stop();
  runtime = null;
  delete window.__asyntaiRoam;
  console.log("[asyntai] extension unloaded");
}
var index_default = { onload, onunload };
export {
  COMMANDS,
  QUIET_MS,
  SLASH_LABEL,
  WATCH_INTERVAL_MS,
  index_default as default,
  pages,
  questionFromBlock
};
