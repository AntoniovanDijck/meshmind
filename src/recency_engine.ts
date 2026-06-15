/**
 * recency_engine.ts — Recency-focused external research (expanded).
 *
 * Conceptualized from `last30days-skill`. Keyless sources, fail-soft per source,
 * date-windowed. Now with more sources, relevance reranking, dedupe, and HN
 * comment enrichment so the top stories carry real discussion signal.
 *
 * Sources (all keyless / no API token):
 *   hackernews  → Algolia search + comment enrichment
 *   reddit      → search.json with an RSS fallback (the load-bearing path)
 *   github      → public search API (recently-pushed repos)
 *   web         → DuckDuckGo HTML
 *   lobsters    → lobste.rs search.json
 *   bluesky     → public.api.bsky.app searchPosts
 *   stackoverflow → api.stackexchange.com advanced search
 *   lemmy       → lemmy.world api/v3/search
 */

export type Source =
  | "hackernews" | "reddit" | "github" | "web"
  | "lobsters" | "bluesky" | "stackoverflow" | "lemmy"
  | "devto" | "github_issues" | "mastodon" | "youtube";

export const ALL_SOURCES: Source[] = [
  "hackernews", "reddit", "github", "web",
  "lobsters", "bluesky", "stackoverflow", "lemmy",
  "devto", "github_issues", "mastodon", "youtube",
];

export interface ResearchItem {
  source: Source;
  title: string;
  url: string;
  text: string;
  score?: number;
  comments?: number;
  author?: string;
  createdAt?: string;
  relevance?: number;   // 0..1 token-overlap with topic (set during rerank)
}

export interface Theme {
  label: string;             // representative phrase
  keywords: string[];
  sources: Source[];         // distinct sources that surfaced this theme
  itemCount: number;
  corroborated: boolean;     // surfaced by >= 2 distinct sources
}

export interface Entity {
  term: string;
  count: number;          // occurrences across items
  sources: Source[];      // distinct sources mentioning it
}

export interface ResearchResult {
  topic: string;
  windowDays: number;
  fetchedAt: string;
  sources: Source[];
  itemCount: number;
  items: ResearchItem[];
  entities: Entity[];     // salient named entities / keywords across results
  themes: Theme[];
  errors: Record<string, string>;
}

const UA = "Mozilla/5.0 (compatible; meshmind/1.0; +https://example.invalid/meshmind)";
const DEFAULT_TIMEOUT_MS = 20_000;

async function httpGet(url: string, accept = "application/json"): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: accept },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function daysAgoUnix(days: number): number {
  return Math.floor((Date.now() - days * 86_400_000) / 1000);
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---- Hacker News + comment enrichment ----------------------------------- */
async function enrichHnComments(objectID: string, max = 3): Promise<string> {
  try {
    const body = await httpGet(`https://hn.algolia.com/api/v1/items/${objectID}`);
    const json = JSON.parse(body);
    const out: string[] = [];
    const walk = (node: any) => {
      if (out.length >= max) return;
      for (const child of node.children ?? []) {
        if (child.text) out.push(stripTags(child.text).slice(0, 280));
        if (out.length >= max) return;
        walk(child);
      }
    };
    walk(json);
    return out.length ? "\nTop comments: " + out.join(" ||| ") : "";
  } catch {
    return "";
  }
}

async function fetchHackerNews(topic: string, windowDays: number, limit: number): Promise<ResearchItem[]> {
  const since = daysAgoUnix(windowDays);
  const params = new URLSearchParams({
    query: topic,
    tags: "story",
    numericFilters: `created_at_i>${since},points>2`,
    hitsPerPage: String(limit),
  });
  const body = await httpGet(`https://hn.algolia.com/api/v1/search?${params}`);
  const hits: any[] = JSON.parse(body).hits ?? [];

  // Enrich the top 3 by points with their hottest comments.
  const top = [...hits].sort((a, b) => (b.points ?? 0) - (a.points ?? 0)).slice(0, 3);
  const enriched = new Map<string, string>();
  await Promise.all(
    top.map(async (h) => enriched.set(h.objectID, await enrichHnComments(h.objectID))),
  );

  return hits.map((h) => ({
    source: "hackernews" as const,
    title: h.title ?? h.story_title ?? "(untitled)",
    url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
    text: stripTags(h.story_text ?? h.comment_text ?? h.title ?? "") + (enriched.get(h.objectID) ?? ""),
    score: h.points,
    comments: h.num_comments,
    author: h.author,
    createdAt: h.created_at,
  }));
}

/* ---- Reddit (search.json + RSS fallback) -------------------------------- */
async function fetchRedditJson(topic: string, windowDays: number, limit: number): Promise<ResearchItem[]> {
  const params = new URLSearchParams({
    q: topic, sort: "new", limit: String(limit),
    t: windowDays <= 7 ? "week" : windowDays <= 31 ? "month" : "year",
    restrict_sr: "false",
  });
  const body = await httpGet(`https://www.reddit.com/search.json?${params}`);
  const cutoff = daysAgoUnix(windowDays);
  const children: any[] = JSON.parse(body)?.data?.children ?? [];
  return children
    .map((c) => c.data)
    .filter((d) => (d.created_utc ?? 0) >= cutoff)
    .map((d) => ({
      source: "reddit" as const,
      title: d.title ?? "(untitled)",
      url: `https://www.reddit.com${d.permalink}`,
      text: stripTags(d.selftext ?? "").slice(0, 1200),
      score: d.score,
      comments: d.num_comments,
      author: d.author,
      createdAt: new Date((d.created_utc ?? 0) * 1000).toISOString(),
    }));
}

async function fetchRedditRss(topic: string, limit: number): Promise<ResearchItem[]> {
  // Keyless RSS search — the residential-safe fallback when .json 403s.
  const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(topic)}&sort=new&limit=${limit}`;
  const body = await httpGet(url, "application/rss+xml, application/xml, text/xml");
  const items: ResearchItem[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(body)) !== null && items.length < limit) {
    const entry = m[1];
    const title = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] ?? "(untitled)";
    const link = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1] ?? "";
    const updated = (entry.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1];
    const content = (entry.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] ?? "";
    items.push({
      source: "reddit",
      title: stripTags(title),
      url: link,
      text: stripTags(content).slice(0, 800),
      createdAt: updated,
    });
  }
  return items;
}

async function fetchReddit(topic: string, windowDays: number, limit: number): Promise<ResearchItem[]> {
  try {
    const json = await fetchRedditJson(topic, windowDays, limit);
    if (json.length) return json;
  } catch {
    /* fall through to RSS */
  }
  return fetchRedditRss(topic, limit);
}

/* ---- GitHub ------------------------------------------------------------- */
async function fetchGitHub(topic: string, windowDays: number, limit: number): Promise<ResearchItem[]> {
  const sinceDate = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const q = encodeURIComponent(`${topic} pushed:>=${sinceDate}`);
  const url = `https://api.github.com/search/repositories?q=${q}&sort=updated&order=desc&per_page=${limit}`;
  const items: any[] = JSON.parse(await httpGet(url, "application/vnd.github+json")).items ?? [];
  return items.map((r) => ({
    source: "github" as const,
    title: r.full_name,
    url: r.html_url,
    text: stripTags(r.description ?? ""),
    score: r.stargazers_count,
    comments: r.open_issues_count,
    author: r.owner?.login,
    createdAt: r.pushed_at,
  }));
}

/* ---- Web (DuckDuckGo HTML) ---------------------------------------------- */
async function fetchWeb(topic: string, limit: number): Promise<ResearchItem[]> {
  const body = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(topic)}`, "text/html");
  const items: ResearchItem[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null && items.length < limit) {
    let href = m[1];
    const dec = href.match(/uddg=([^&]+)/);
    if (dec) href = decodeURIComponent(dec[1]);
    items.push({ source: "web", title: stripTags(m[2]), url: href, text: "" });
  }
  return items;
}

/* ---- Lobsters ----------------------------------------------------------- */
async function fetchLobsters(topic: string, limit: number): Promise<ResearchItem[]> {
  // search.json is flaky (400s on many queries); the newest.json feed is stable
  // and keyless. Pull the recent firehose and filter to topic tokens locally.
  const arr: any[] = JSON.parse(await httpGet("https://lobste.rs/newest.json"));
  const terms = (topic.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2);
  const match = (s: any) => {
    const hay = `${s.title ?? ""} ${(s.tags ?? []).join(" ")} ${s.description ?? ""}`.toLowerCase();
    return terms.length === 0 || terms.some((t) => hay.includes(t));
  };
  return (Array.isArray(arr) ? arr : [])
    .filter(match)
    .slice(0, limit)
    .map((s) => ({
      source: "lobsters" as const,
      title: s.title ?? "(untitled)",
      url: s.url || s.short_id_url,
      text: stripTags(s.description ?? ""),
      score: s.score,
      comments: s.comment_count,
      author: s.submitter_user?.username ?? s.submitter_user,
      createdAt: s.created_at,
    }));
}

/* ---- Bluesky (public) --------------------------------------------------- */
async function fetchBluesky(topic: string, windowDays: number, limit: number): Promise<ResearchItem[]> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const url =
    `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts` +
    `?q=${encodeURIComponent(topic)}&limit=${limit}&sort=latest&since=${encodeURIComponent(since)}`;
  const posts: any[] = JSON.parse(await httpGet(url)).posts ?? [];
  return posts.map((p) => ({
    source: "bluesky" as const,
    title: stripTags(p.record?.text ?? "").slice(0, 100) || "(post)",
    url: `https://bsky.app/profile/${p.author?.handle}/post/${(p.uri ?? "").split("/").pop()}`,
    text: stripTags(p.record?.text ?? ""),
    score: p.likeCount,
    comments: p.replyCount,
    author: p.author?.handle,
    createdAt: p.record?.createdAt ?? p.indexedAt,
  }));
}

/* ---- Stack Overflow ----------------------------------------------------- */
async function fetchStackOverflow(topic: string, windowDays: number, limit: number): Promise<ResearchItem[]> {
  const fromDate = daysAgoUnix(windowDays);
  const url =
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=creation` +
    `&q=${encodeURIComponent(topic)}&fromdate=${fromDate}&pagesize=${limit}&site=stackoverflow`;
  const items: any[] = JSON.parse(await httpGet(url)).items ?? [];
  return items.map((q) => ({
    source: "stackoverflow" as const,
    title: stripTags(q.title ?? "(untitled)"),
    url: q.link,
    text: (q.tags ?? []).join(", "),
    score: q.score,
    comments: q.answer_count,
    author: q.owner?.display_name,
    createdAt: new Date((q.creation_date ?? 0) * 1000).toISOString(),
  }));
}

/* ---- Lemmy -------------------------------------------------------------- */
async function fetchLemmy(topic: string, limit: number): Promise<ResearchItem[]> {
  const url = `https://lemmy.world/api/v3/search?q=${encodeURIComponent(topic)}&type_=Posts&sort=New&limit=${limit}`;
  const posts: any[] = JSON.parse(await httpGet(url)).posts ?? [];
  return posts.map((p) => ({
    source: "lemmy" as const,
    title: p.post?.name ?? "(untitled)",
    url: p.post?.url || p.post?.ap_id,
    text: stripTags(p.post?.body ?? "").slice(0, 800),
    score: p.counts?.score,
    comments: p.counts?.comments,
    author: p.creator?.name,
    createdAt: p.post?.published,
  }));
}

/* ---- Dev.to ------------------------------------------------------------- */
async function fetchDevto(topic: string, windowDays: number, limit: number): Promise<ResearchItem[]> {
  // Dev.to has no full-text search API; pull recent top articles and filter to
  // topic tokens client-side (keyless, stable).
  const url = `https://dev.to/api/articles?per_page=100&top=${windowDays}`;
  const arr: any[] = JSON.parse(await httpGet(url));
  const terms = (topic.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2);
  const match = (a: any) => {
    const hay = `${a.title ?? ""} ${(a.tag_list ?? []).join(" ")} ${a.description ?? ""}`.toLowerCase();
    return terms.length === 0 || terms.some((t) => hay.includes(t));
  };
  return (Array.isArray(arr) ? arr : [])
    .filter(match)
    .slice(0, limit)
    .map((a) => ({
      source: "devto" as const,
      title: a.title ?? "(untitled)",
      url: a.url,
      text: stripTags(a.description ?? ""),
      score: a.positive_reactions_count,
      comments: a.comments_count,
      author: a.user?.username,
      createdAt: a.published_at,
    }));
}

/* ---- GitHub issues (recent activity) ------------------------------------ */
async function fetchGitHubIssues(topic: string, windowDays: number, limit: number): Promise<ResearchItem[]> {
  const sinceDate = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const q = encodeURIComponent(`${topic} in:title,body created:>=${sinceDate}`);
  const url = `https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=${limit}`;
  const items: any[] = JSON.parse(await httpGet(url, "application/vnd.github+json")).items ?? [];
  return items.map((i) => ({
    source: "github_issues" as const,
    title: i.title,
    url: i.html_url,
    text: stripTags((i.body ?? "").slice(0, 600)),
    score: i.reactions?.total_count,
    comments: i.comments,
    author: i.user?.login,
    createdAt: i.created_at,
  }));
}

/* ---- Mastodon (public search on a large instance) ----------------------- */
async function fetchMastodon(topic: string, windowDays: number, limit: number): Promise<ResearchItem[]> {
  // Tag timelines are public + keyless. Use the first topic token as the tag.
  const tag = (topic.toLowerCase().match(/[a-z0-9]+/g) ?? ["news"])[0];
  const url = `https://mastodon.social/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=${limit}`;
  const arr: any[] = JSON.parse(await httpGet(url));
  const cutoff = daysAgoUnix(windowDays) * 1000;
  return (Array.isArray(arr) ? arr : [])
    .filter((s) => new Date(s.created_at ?? 0).getTime() >= cutoff)
    .map((s) => ({
      source: "mastodon" as const,
      title: stripTags(s.content ?? "").slice(0, 100) || "(toot)",
      url: s.url ?? s.uri,
      text: stripTags(s.content ?? ""),
      score: s.favourites_count,
      comments: s.replies_count,
      author: s.account?.acct,
      createdAt: s.created_at,
    }));
}

/* ---- YouTube (keyless via Piped mirrors; RSS needs a channel id) --------- */
const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
];
async function fetchYouTube(topic: string, windowDays: number, limit: number): Promise<ResearchItem[]> {
  let lastErr: unknown;
  for (const base of PIPED_INSTANCES) {
    try {
      const url = `${base}/search?q=${encodeURIComponent(topic)}&filter=videos`;
      const json = JSON.parse(await httpGet(url));
      const cutoff = Date.now() - windowDays * 86_400_000;
      const vids: any[] = json.items ?? json ?? [];
      return vids
        .filter((v) => (v.type ?? "stream") === "stream")
        // uploaded is ms epoch on Piped; -1 when unknown → keep (best-effort).
        .filter((v) => (v.uploaded ?? -1) === -1 || v.uploaded >= cutoff)
        .slice(0, limit)
        .map((v) => ({
          source: "youtube" as const,
          title: v.title ?? "(video)",
          url: v.url?.startsWith("http") ? v.url : `https://www.youtube.com${v.url ?? ""}`,
          text: stripTags(v.shortDescription ?? v.uploaderName ?? ""),
          score: v.views,
          author: v.uploaderName,
          createdAt: v.uploaded && v.uploaded > 0 ? new Date(v.uploaded).toISOString() : v.uploadedDate,
        }));
    } catch (e) {
      lastErr = e; // try next mirror
    }
  }
  throw new Error(`all Piped mirrors failed: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

const FETCHERS: Record<Source, (t: string, w: number, l: number) => Promise<ResearchItem[]>> = {
  hackernews: fetchHackerNews,
  reddit: fetchReddit,
  github: fetchGitHub,
  web: (t, _w, l) => fetchWeb(t, l),
  lobsters: (t, _w, l) => fetchLobsters(t, l),
  bluesky: fetchBluesky,
  stackoverflow: fetchStackOverflow,
  lemmy: (t, _w, l) => fetchLemmy(t, l),
  devto: fetchDevto,
  github_issues: fetchGitHubIssues,
  mastodon: fetchMastodon,
  youtube: fetchYouTube,
};

/* ---- relevance reranking + dedupe --------------------------------------- */
const STOP = new Set(["the", "a", "an", "of", "to", "in", "for", "and", "or", "is", "on", "with"]);

function tokenize(s: string): Set<string> {
  return new Set(
    (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Jaccard-ish overlap of topic tokens against an item's title+text. */
function relevanceScore(topicTokens: Set<string>, item: ResearchItem): number {
  if (topicTokens.size === 0) return 0;
  const itemTokens = tokenize(`${item.title} ${item.text}`);
  let hit = 0;
  for (const t of topicTokens) if (itemTokens.has(t)) hit++;
  return Math.round((hit / topicTokens.size) * 100) / 100;
}

function normalizeUrl(u: string): string {
  return u.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
}

function dedupe(items: ResearchItem[]): ResearchItem[] {
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const out: ResearchItem[] = [];
  for (const it of items) {
    const u = it.url ? normalizeUrl(it.url) : "";
    const t = it.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (u && seenUrl.has(u)) continue;
    if (t && seenTitle.has(t)) continue;
    if (u) seenUrl.add(u);
    if (t) seenTitle.add(t);
    out.push(it);
  }
  return out;
}

/* ---- entity / keyword extraction ---------------------------------------- */
/**
 * Algorithmic entity extraction (no NER model). Pulls two signal classes:
 *   - proper-noun phrases: runs of Capitalized words (products, projects, orgs)
 *   - technical tokens: CamelCase, snake_case, dotted, or version-like terms
 * Ranks by frequency × source-spread (a term seen across sources scores higher).
 */
const ENTITY_FILLER = new Set([
  "the", "this", "that", "these", "those", "introduction", "overview", "guide",
  "tutorial", "how", "why", "what", "when", "new", "best", "top", "using", "use",
  "first", "last", "next", "more", "about", "with", "from", "your", "our", "their",
  "show", "tell", "ask", "update", "release", "version", "part", "post", "article",
]);

function extractEntities(items: ResearchItem[], topic: string): Entity[] {
  const topicTokens = tokenize(topic);
  const byTerm = new Map<string, { count: number; sources: Set<Source> }>();

  const bump = (raw: string, src: Source) => {
    const term = raw.trim();
    if (term.length < 3 || term.length > 40) return;
    const key = term.toLowerCase();
    if (topicTokens.has(key)) return; // the query itself isn't an "entity"
    // Reject single-word filler (capitalized sentence-starters, generic nouns).
    if (!/[\s.:_-]/.test(term) && ENTITY_FILLER.has(key)) return;
    const e = byTerm.get(key) ?? { count: 0, sources: new Set<Source>() };
    e.count++;
    e.sources.add(src);
    byTerm.set(key, e);
    // preserve a display-cased variant
    if (!display.has(key)) display.set(key, term);
  };
  const display = new Map<string, string>();

  const properNoun = /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,2})\b/g;
  const techToken = /\b([a-z]+[A-Z]\w+|\w+(?:[._-]\w+)+|v?\d+\.\d+(?:\.\d+)?)\b/g;

  for (const it of items) {
    const hay = `${it.title} ${it.text}`;
    let m: RegExpExecArray | null;
    properNoun.lastIndex = 0;
    while ((m = properNoun.exec(hay)) !== null) bump(m[1], it.source);
    techToken.lastIndex = 0;
    while ((m = techToken.exec(hay)) !== null) bump(m[1], it.source);
  }

  return [...byTerm.entries()]
    .map(([key, v]) => ({ term: display.get(key)!, count: v.count, sources: [...v.sources] }))
    .filter((e) => e.count >= 2 || e.sources.length >= 2)
    .sort((a, b) => b.sources.length * 5 + b.count - (a.sources.length * 5 + a.count))
    .slice(0, 15);
}

/* ---- fusion: cross-source theme clustering ------------------------------ */
/**
 * Greedy token-overlap clustering over item titles. Each cluster is a "theme";
 * a theme surfaced by >= 2 distinct sources is "corroborated" — independent
 * communities are talking about the same thing, which is a strong recency
 * signal. Returns themes plus a per-item corroboration map for rank boosting.
 */
function fuse(items: ResearchItem[]): { themes: Theme[]; boost: Map<ResearchItem, number> } {
  const tokenized = items.map((it) => ({ it, toks: tokenize(`${it.title}`) }));
  const used = new Set<number>();
  const clusters: { members: number[]; keywords: Set<string> }[] = [];

  for (let i = 0; i < tokenized.length; i++) {
    if (used.has(i)) continue;
    const cluster = { members: [i], keywords: new Set(tokenized[i].toks) };
    used.add(i);
    for (let j = i + 1; j < tokenized.length; j++) {
      if (used.has(j)) continue;
      let shared = 0;
      for (const t of tokenized[j].toks) if (cluster.keywords.has(t)) shared++;
      // Need 2+ shared significant tokens to join — avoids spurious merges.
      if (shared >= 2) {
        cluster.members.push(j);
        used.add(j);
        for (const t of tokenized[j].toks) cluster.keywords.add(t);
      }
    }
    clusters.push(cluster);
  }

  const boost = new Map<ResearchItem, number>();
  const themes: Theme[] = [];
  for (const c of clusters) {
    if (c.members.length < 2) continue; // singletons aren't themes
    const members = c.members.map((idx) => tokenized[idx].it);
    const sources = [...new Set(members.map((m) => m.source))];
    const corroborated = sources.length >= 2;
    // Boost every member; corroborated themes boost harder.
    for (const m of members) boost.set(m, (corroborated ? 0.5 : 0.2) * Math.log2(members.length + 1));
    const keywords = [...c.keywords].slice(0, 6);
    themes.push({
      label: members[0].title.slice(0, 80),
      keywords,
      sources,
      itemCount: members.length,
      corroborated,
    });
  }
  // Corroborated, larger themes first.
  themes.sort((a, b) => Number(b.corroborated) - Number(a.corroborated) || b.itemCount - a.itemCount);
  return { themes, boost };
}

export interface ResearchOptions {
  windowDays?: number;
  sources?: Source[];
  perSource?: number;
}

/** Run recency research across sources in parallel; rerank + dedupe; never throws. */
export async function research(topic: string, options: ResearchOptions = {}): Promise<ResearchResult> {
  const windowDays = options.windowDays ?? 30;
  const sources = options.sources ?? ALL_SOURCES;
  const perSource = options.perSource ?? 10;

  const errors: Record<string, string> = {};
  const settled = await Promise.allSettled(sources.map((s) => FETCHERS[s](topic, windowDays, perSource)));

  let items: ResearchItem[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else errors[sources[i]] = String(r.reason?.message ?? r.reason);
  });

  // Relevance scoring, then dedupe, then fuse (theme clustering + corroboration
  // boost), then rank by relevance × engagement × corroboration.
  const topicTokens = tokenize(topic);
  for (const it of items) it.relevance = relevanceScore(topicTokens, it);
  items = dedupe(items);

  const entities = extractEntities(items, topic);
  const { themes, boost } = fuse(items);
  items.sort((a, b) => {
    const ea = (a.score ?? 0) + (a.comments ?? 0);
    const eb = (b.score ?? 0) + (b.comments ?? 0);
    const ra = (a.relevance ?? 0) * 10 + Math.log10(ea + 1) + (boost.get(a) ?? 0);
    const rb = (b.relevance ?? 0) * 10 + Math.log10(eb + 1) + (boost.get(b) ?? 0);
    return rb - ra;
  });

  return {
    topic,
    windowDays,
    fetchedAt: new Date().toISOString(),
    sources,
    itemCount: items.length,
    items,
    entities,
    themes,
    errors,
  };
}

export function researchToText(result: ResearchResult): string {
  const lines: string[] = [
    `# Research: ${result.topic} (last ${result.windowDays} days)`,
    `fetched=${result.fetchedAt} items=${result.itemCount} sources=[${result.sources.join(",")}]`,
    ``,
  ];
  if (result.entities.length) {
    lines.push(`## Key entities`);
    lines.push(result.entities.map((e) => `${e.term}(${e.count}/${e.sources.length}src)`).join(", "));
    lines.push("");
  }
  if (result.themes.length) {
    lines.push(`## Themes (fused across sources)`);
    for (const t of result.themes.slice(0, 8)) {
      const mark = t.corroborated ? "✦ corroborated" : "·";
      lines.push(`- ${mark} [${t.sources.join("/")}] ${t.label} (${t.itemCount} items)`);
    }
    lines.push("");
  }
  for (const it of result.items) {
    const eng = [
      it.score != null ? `${it.score}pts` : "",
      it.comments != null ? `${it.comments}c` : "",
      it.relevance != null ? `rel=${it.relevance}` : "",
    ].filter(Boolean).join(" ");
    lines.push(`## [${it.source}] ${it.title} ${eng}`.trim());
    lines.push(it.url);
    if (it.createdAt) lines.push(`date: ${it.createdAt}`);
    if (it.text) lines.push(it.text);
    lines.push("");
  }
  if (Object.keys(result.errors).length) {
    lines.push(`## source errors`);
    for (const [k, v] of Object.entries(result.errors)) lines.push(`- ${k}: ${v}`);
  }
  return lines.join("\n");
}
