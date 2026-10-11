# The memory net

NEO's memory is a **network**, not a list of notes. Like human memory, it has

- **different kinds of memories**: episodes (what happened), facts, entities (people, places, pets, projects), preferences, skills, goals, and summaries;
- **associations** between them, with strengths that grow when memories are used together (Hebbian learning) and fade when they aren't;
- **recall by spreading activation**: what you say activates matching memories, and activation flows along associations to related ones, so NEO "is reminded of" things that never shared a keyword with your message;
- **forgetting curves**: unused memories fade (retention `R = e^(−Δt/S)`). Each recall strengthens a memory more when it was nearly forgotten (the spacing effect);
- **consolidation ("sleep")**: in idle time, NEO prunes faded links, archives faded memories, links similar ones, merges duplicate entities, and abstracts clusters of episodes into lasting knowledge. A **dream journal** shows what changed;
- **belief revision**: new information *supersedes* old beliefs instead of silently overwriting them ("you used to prefer aisle seats");
- **provenance**: every memory knows where it came from (conversation, message, and whether extraction, the user, a tool or consolidation wrote it).

And because it's *your* assistant, **you control all of it**. You can see the whole net, edit, pin, forget, export and import it. You can require approval before anything is remembered, block topics, keep sensitive memories away from cloud models (and cloud embedders), and use incognito conversations.

Public API: `MemoryService` in `@neo/protocol` (`memory.ts`). Implementation: `@neo/memory` (`packages/memory/src`). Constants: `MEMORY_CONSTANTS` and `BASE_STABILITY_DAYS`, defined in `constants.ts` and re-exported from `index.ts`; names below refer to them, and [Constants](#constants) lists every value.

## Data model (SQLite, migration namespace `memory`)

One migration, version 1 (`initial`), in `schema.ts`:

```sql
CREATE TABLE IF NOT EXISTS memory_nodes (
  id TEXT PRIMARY KEY,                 -- "mem_…"
  kind TEXT NOT NULL,                  -- episode|fact|entity|preference|skill|goal|summary
  label TEXT NOT NULL,
  norm_label TEXT NOT NULL,            -- normalizeText(label): NFKC, lower case, single spaces, trimmed
  content TEXT NOT NULL,
  entity_type TEXT,
  aliases TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  tags TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  stability REAL NOT NULL,             -- days
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,         -- moves on edits only, never on reinforcement
  status TEXT NOT NULL,                -- active|pending|archived|superseded
  pinned INTEGER NOT NULL DEFAULT 0,
  sensitivity TEXT NOT NULL DEFAULT 'normal',   -- normal|sensitive
  source TEXT NOT NULL,                -- JSON MemorySource {by, conversationId?, messageId?, note?}
  embedding_model TEXT,                -- model id of the stored vector; NULL = needs (re-)embedding
  valid_until INTEGER,
  consolidated_at INTEGER,
  metadata TEXT                        -- JSON; revisions keep {reason?}, pending ones also {supersedes: <id>}
);
CREATE INDEX IF NOT EXISTS memory_nodes_by_status ON memory_nodes (status, kind);
CREATE INDEX IF NOT EXISTS memory_nodes_by_label ON memory_nodes (kind, norm_label);

CREATE TABLE IF NOT EXISTS memory_vectors (
  node_id TEXT PRIMARY KEY REFERENCES memory_nodes (id) ON DELETE CASCADE,
  model TEXT NOT NULL,                 -- main embedder id, or the local fallback's ("local-hash2-512")
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL                 -- little-endian Float32, L2-normalized
);

CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,                 -- "edge_…"
  src TEXT NOT NULL REFERENCES memory_nodes (id) ON DELETE CASCADE,
  dst TEXT NOT NULL REFERENCES memory_nodes (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  weight REAL NOT NULL,                -- weight as of last_reinforced_at
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_reinforced_at INTEGER NOT NULL,
  coactivations INTEGER NOT NULL DEFAULT 0,
  UNIQUE (src, dst, type)
);
CREATE INDEX IF NOT EXISTS memory_edges_by_src ON memory_edges (src);
CREATE INDEX IF NOT EXISTS memory_edges_by_dst ON memory_edges (dst);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5 (node_id UNINDEXED, label, content, aliases, tags);

CREATE TABLE IF NOT EXISTS memory_journal (
  id TEXT PRIMARY KEY,                 -- "cons_…"
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  report TEXT NOT NULL                 -- ConsolidationReport JSON + private noteRefs
);

CREATE TABLE IF NOT EXISTS memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                  -- only key today: lastConsolidationAt (epoch ms)
);
```

- `MemoryEdge.from/to` map to `src/dst`. Edges are directed for meaning (`fact —about→ entity`), but activation spreads both ways. For the symmetric types `related`, `similar` and `contradicts`, an edge in either direction counts as "the" edge (no reverse duplicates are created).
- **Edge types**: `related`, `about`, `mentions`, `part_of`, `derived_from`, `supersedes`, `contradicts`, `precedes`, `causes`, `similar`. The **structural** ones (`about`, `part_of`, `derived_from`, `supersedes`, `precedes`) never decay and are never pruned.
- **FTS**: the service maintains `memory_fts` itself: one row per node, `aliases` and `tags` joined with spaces, rewritten only when label, content, aliases or tags change.
- **Hard deletes** remove the FTS row, every edge touching the node, the vector row and the node row explicitly (not only through `ON DELETE CASCADE`), so nothing survives on a connection opened without `foreign_keys`. The node also leaves every in-memory vector cache.
- A node has **one vector row**. It lives in the embedding space the node belongs to (see the next section). `embedding_model` names that model, or is `NULL` when the node still needs a vector.

## Embeddings and vector spaces

**Embedding text** of a node: `"<kind>: <label>. <content>"`, plus `" Also known as: <a>, <b>"` when it has aliases. A new entity created for a name embeds as `"entity: <name>. Entity: <name>"`.

**Embedders**

- `HashingEmbedder(512)`, id `hash2-512`, is the offline default (`isLocal = true`). The id is versioned: when the features change, the id changes too, so the vectors stored by an older version (`hash-512`) are re-embedded automatically (see re-embedding below). It applies NFKC, lower-cases the text and splits it on whitespace, punctuation and symbols. Within a segment, each character of an unspaced script (Han, Hiragana, Katakana and Hangul, as in `text.ts`, plus `ー` and CJK symbols) becomes a single-character token, plus a token for each pair of adjacent such characters; every other run is a word. It works by code point, so a pair never splits a surrogate pair (`𠮷野` is a pair). Features: each distinct token with weight `ln(1 + tf)`; character trigrams (`"#abc"`, by code point; a 2-character token is used whole) of non-CJK tokens of ≥ 2 characters, with weight `0.5 · ln(1 + tf)`; and pairs of neighbors in the list of distinct tokens (first-occurrence order) when both are non-CJK, with weight `0.7 · ln(1 + min(tf))`. Each feature is hashed with 32-bit FNV-1a over its UTF-8 bytes into bucket `h mod 512`, with sign `+` if bit 16 of `h` is 0, else `−`. The vector is L2-normalized. It is deterministic and dependency-free.
- `createProviderEmbedder(adapter, model)`, id `<provider>:<model>`, wraps the provider's embeddings endpoint (OpenAI `text-embedding-3-small`, Ollama `nomic-embed-text`, Gemini `gemini-embedding-001`, …). It sends batches of 64, checks that the count matches, that values are finite and that dimensions never change, and L2-normalizes. `isLocal` is the adapter's own `isLocal === true`. An embedder that doesn't say it is local is treated as remote.
- `LocalFallbackEmbedder(512)`, id **`local-hash2-512`**, is a `HashingEmbedder` under its own id (`local-` + the hashing embedder's id). When the main embedder is remote, it embeds every text that must stay on the device (see below). The separate id keeps its vectors in a **separate vector space**.

**Which embedder a text goes to.** `localEmbedder = embedder` when the main embedder is local, else a `LocalFallbackEmbedder`. A memory **must stay on the device** (`keepLocal`) when the main embedder is remote and the memory is either sensitive (unless `policy.sendSensitiveToCloud`) or pending approval. Its text, and the names of entities created for it, go only to `local-hash2-512`, and its vector is stored under that model id. Vectors of different models are never compared with each other, even when they have the same dimensions: dedupe (also the same-turn dedupe), MMR, link discovery and entity merging only compare vectors of the same model, and recall embeds the query in each space (see [Read path](#read-path-recallquery)).

**Cache.** One `Map<nodeId, Float32Array>` per model id, loaded lazily from `memory_vectors`. Writers compute embeddings before their transaction, write the vector rows inside it, and update the cache only after commit, so a rollback never leaves a stale vector in the cache. A zero vector (some endpoints return one) is kept as-is: it matches nothing, but the node counts as embedded. A corrupt blob counts as missing.

**Re-embedding** (`reembedStale`) selects nodes whose `embedding_model` is `NULL` or differs from the main embedder's id. It works in batches of 64, ordered by id and yielding between batches. Each node goes to the embedder where it belongs, and a node already stored in its target space is skipped. Before storing a vector, it re-checks that the node's text and place haven't changed meanwhile. It never touches `updated_at`. Concurrent calls share one pass, plus one more pass if nodes were added while it ran. Re-embedding runs:

- at service start and after a live embedder change, including a new version of the hashing embedder (`hash-512` → `hash2-512`, `local-hash-512` → `local-hash2-512`); changes to embedding settings or the selected provider rebuild the live embedder, and an unavailable provider falls back to `hash2-512`;
- after any write that couldn't embed (embedder failure), or whose vector was computed in another space than the one the node belongs to (a merge that replaced a sensitive memory's content, see [the create path](#the-create-path));
- after a node moved place (approved, or became sensitive);
- when `sendSensitiveToCloud` is switched on (sensitive memories move to the main embedder), and when it is switched off again: sensitive memories embedded by the main embedder get `embedding_model = NULL`, their main-model vectors leave the cache at once, and they are re-embedded on the device (their text is not sent anywhere);
- as the first step of consolidation.

Recall keeps working meanwhile: a node without a vector just isn't a vector seed.

## Strength over time

- **Retention**: `R(t) = 1` if pinned, else `exp(−Δt / S)` with `Δt` = days since `lastAccessedAt ?? createdAt` (never negative).
- **Initial stability** `S₀ = BASE_STABILITY_DAYS[kind] × (0.5 + clamp01(importance))` (episode 3, fact 30, entity 90, preference 60, skill 45, goal 14, summary 30 days).
- **Reinforcement on use**:
  `S ← min(maxStabilityDays, S × (1 + stabilityGain × (1 − R_now)) + stabilityEpsilonDays)`; `accessCount += 1`; `lastAccessedAt = max(now, lastAccessedAt)`.
  Recalling a nearly forgotten memory almost doubles its stability, while recalling a fresh one barely changes it (the spacing effect). Reinforcement is an access, not an edit, so `updated_at` and the FTS row don't change. It is applied:
  - to memories recalled with `reinforce !== false` while the mode isn't `off`;
  - when a create merges into an existing memory (re-mention, a duplicate `remember`);
  - by an extracted `update` op;
  - by an extracted `reinforce` op (active memories only).
- **Edges**: effective weight `w_eff = w × 0.5^(Δt / edgeHalfLifeDays)` for the non-structural types (`related`, `mentions`, `similar`, `causes`, `contradicts`), with `Δt` = days since `last_reinforced_at`. Structural types keep `w`.
- **Hebbian co-activation**: after a reinforcing recall, the selected memories whose strongest seed source was the query itself (vector, keyword or entity, but not the pinned "core" or profile seeds, so always-on memories don't get wired to everything) are ranked by score. Every pair among the top `hebbianPairs` (5) gets its `related` edge (either direction) strengthened: `w ← min(1, w_eff + hebbianRate × (1 − w_eff))`, `coactivations += 1`, `last_reinforced_at = now`. A missing edge is created at `hebbianRate` with `coactivations = 1`.

## Read path: `recall(query)`

```ts
recall({ text, context?, conversationId?, limit?, tokenBudget?, kinds?, allowSensitive?, includeArchived?, reinforce?, now? })
```

- `text` is what the user said. It drives every seed source (semantic, keyword, entity, profile).
- `context` is optional surrounding text. It can only nudge the semantic similarity up, and it never feeds keyword, entity or profile seeds, so NEO's own wording can't flood recall.
- `conversationId` is the conversation being answered.
- `limit` defaults to `policy.recallLimit` (12) and `tokenBudget` to `policy.recallTokenBudget` (1500).
- An empty `text` or `limit = 0` returns nothing.

**Callers.**

- **Core**, before each turn, unless the conversation is incognito or `policy.recall` is false. It passes:
  - `text`: the user's text parts plus the descriptions of UI events (tags removed);
  - `context`: the last ≤ 300 characters of the previous assistant reply;
  - `conversationId`;
  - `limit` and `tokenBudget` from the policy;
  - `allowSensitive = chatAdapter.isLocal || policy.sendSensitiveToCloud`.

  A failure is logged and the turn continues without memories.
- **The model's `recall` tool**: `{ text: query, limit: limit ?? 8 (≤ 20), allowSensitive, conversationId }`. When `policy.recall` is false (read on every call), it doesn't recall and answers `{ memories: [], note: "Memory recall is turned off …" }`: a normal result, not an error the model would retry. Incognito conversations don't have the tool (see [Privacy rules](#privacy-rules-summary)).

Both reinforce.

1. **Candidates**: `status = 'active'` (plus `archived` with `includeArchived`) and not expired (`valid_until IS NULL OR valid_until > now`). With `kinds`, only those kinds. **Sensitive memories are excluded unless `allowSensitive`**. With a `conversationId`, **that conversation's own episodes are excluded**: they are already in the transcript (working memory). Facts learned in it, and other conversations' episodes, stay recallable. Pending and superseded memories are never recalled. Every seed source and every spreading step is restricted to candidates.
2. **Seeds** (a node's seed activation is the max over the sources, and the winning source names it):
   - *Vector*: the query is embedded per space. In the main space, `text` goes always, and `context` only if the main embedder is local, or `allowSensitive` is false, or `sendSensitiveToCloud` is set (a local model's reply may quote sensitive memories). When the main embedder is remote, the query is also embedded in the `local-hash2-512` space, with the context. Each candidate is compared in the space of its stored vector (main if it has one, else local). The **blended similarity** is

     ```
     s_text = cos(q_text, v)       s_ctx = cos(q_context, v)
     sim    = s_text + recallContextWeight × max(0, s_ctx − s_text)        # recallContextWeight = 0.2
     ```

     So `sim ≤ 0.2 + 0.8 × s_text`. A memory that shares nothing with what the user said (`s_text ≤ 0`) stays at or below the floor: the context alone never recalls anything. The top `seedTopK` (24) with `sim > seedSimilarityFloor` (0.2) seed with `a₀ = (sim − 0.2) / 0.8`. If embedding a space fails, recall continues without vector seeds from that space.
   - *Keyword*: rarity-weighted overlap of meaningful terms of `text` (never the context):

     ```
     terms   = recallTerms(text)                          # ≤ 32 words + ≤ 32 CJK terms
     df(t)   = number of candidates containing t
     N       = |candidates| + lexicalIdfPrior             # +20 pseudo-memories without t (smoothing)
     idf(df) = ln(1 + (N − df + 0.5) / (df + 0.5))
     w(t)    = idf(df(t)) / idf(1)                        # 1 for a term only one memory has
     ignore t if df = 0, or if |candidates| ≥ 20 and df > lexicalMaxDocShare (0.5) × |candidates|
     relevance(m) = Σ w(t) over the terms m contains
     ```

     Memories with `relevance ≥ lexicalMinRelevance` (0.35) seed, the top `lexicalTopK` (24) by relevance (ties by id), with `a₀ = lexicalMaxActivation (0.8) × min(1, relevance)`. The `+20` prior means a small net still matches its own topic word (four memories about Kyoto all match "Kyoto"). In a large net, a word many memories share fades: with 200 candidates, a term in 10 of them weighs ≈ 0.61. Terms (`text.ts`):
     - **Words**: CJK runs are removed, the rest is split on anything but letters, marks, digits, `_` and apostrophes, possessive `'s` is stripped, and contractions are split at the apostrophe. Stopwords are dropped: function words, plus words every memory or request contains (`user`, `neo`, `remember`, `recall`, `tell`, `know`, `please`, …), plus recall-only stopwords that say how or when rather than what (`like`, `love`, `prefer`, `want`, `need`, `really`, `today`, `time`, time units, `thing`, `good`, …). A word is kept if it has ≥ 3 characters, or is a 2-letter acronym typed in capitals ("AI"), or is a number of ≥ 4 digits (a year). Words match whole FTS5 tokens of `label`, `content`, `aliases` and `tags`, together with their simple English plural/singular forms (`"tea" OR "teas"`).
     - **CJK** (FTS5 keeps a whole CJK run as one token, so CJK is matched by **character bigrams**): runs of Han, Hiragana, Katakana and Hangul (plus `ー々`) are split at stop characters (我 你 您 的 了 是 吗 好 很 这 那 在 请 把 被 给 …, and all Hiragana) and at two-character stop words (喜欢 知道 记得 什么 怎么 今天 现在 用户 告诉 关于 …). Adjacent content characters give bigrams, and an isolated content character stands alone ("我的猫" → "猫", "我喜欢喝茶" → "喝茶"). CJK terms match as substrings of `label + content + aliases + tags` (NFKC, lower case).
   - *Entity*: for each candidate entity, its label and aliases are normalized (NFKC, lower case, single spaces). A name of ≥ 2 characters (or any CJK name) that occurs in the normalized `text` gives `a₀ = 1`. The match must be a whole word (Unicode-aware: letters, marks, digits and `_` are word characters, so "Zoë" and "C++" work and "Al" doesn't match inside "Alice") or a substring for CJK/kana/hangul names. Skipped when `kinds` excludes `entity`.
   - *Profile*: a broad question about the user ("what do you remember about me?", "who am I", "the user", "what does the user like?", "你记得我什么", "关于用户的信息") shares no content word with any memory. `isBroadSelfQuery(text)` is true when the text is either:
     - self-referential (I/me/my/…, 我/自己/私/僕/俺/나/저) **and** phrased as a question or recall request ("?", what/who/how/which/tell/describe/remember/recall/know/summarize/profile, 记得/知道/什么/介绍/…), **and** every other word is filler (verbs of knowing, "about", "like", "hobbies", "preferences", …);
     - or a third-person query naming the user ("user", "the user", "user preferences", 用户, 关于用户的信息) with only filler around it.

     Chit-chat like "I like it" is not a profile question. When it is one, the top `profileSeedLimit` (8) active candidates of kinds fact, preference, goal and entity (within the `kinds` filter), ranked by `importance × R` (ties by id), seed at `profileActivation` (0.35). Every candidate filter still applies (sensitivity, conversation, expiry).
   - *Core*: up to `pinnedAlwaysLimit` (6) pinned candidates, highest importance first (ties by id), get at least `pinnedActivationFloor` (0.3).
3. **Spreading activation** (`spreadHops` = 2 hops, decay `D = spreadDecay` = 0.5):
   ```
   A ← seeds; frontier ← seeds
   repeat spreadHops times:
     inc ← {}
     for i in frontier with A[i] > 0:
       N(i) ← edges (i, j), either direction, j a candidate, j ≠ i, w_eff ≥ minEdgeWeight (0.05)
       fan ← max(1, √|N(i)|)                                # ACT-R fan effect: hubs spread thinner
       for (i, j, edge) in N(i):
         c ← A[i] × w_eff × D / fan
         inc[j] += c; if j is not a seed: keep the (i, edge) with the largest single c as j's back-pointer
     for j in inc: A[j] ← min(1, A[j] + inc[j])
     frontier ← top frontierLimit (200) of inc
   ```
   `via` for a node is the chain of back-pointers to a seed (at most `spreadHops + 1` steps). It answers "why do you remember this?".
4. **Score**: `strength = strengthBase + weightRetention·R + weightImportance·importance + weightConfidence·confidence` (0.5 … 1.0), then `score = A × strength × (pinned ? pinnedBoost : 1)`. Activation gates everything: an irrelevant memory never surfaces just because it's important. Nodes with `score < policy.minScore` (0.15) are dropped.
5. **Select**: from the top `max(8 × limit, 64)` by score (ties by id), MMR with `λ = mmrLambda` (0.7) repeatedly picks `argmax λ·score − (1−λ)·maxSim(selected)`. `maxSim` only compares vectors of the same model. Selection stops at `limit` items. Under the token budget (`estimateTokens(label + " " + content)` = ⌈chars / 4⌉), a memory that doesn't fit in what's left is skipped, and smaller ones may still fill the budget.
6. **Reinforce**: `recall` itself is a pure read. Afterwards the service applies reinforcement to the selected nodes and Hebbian co-activation among the selected query seeds. It skips this when `reinforce === false` or `policy.mode === 'off'` (with memory off, nothing is written, not even strength). A failure there is logged, not thrown.
7. **Explain**: `reason` is one of:
   - `"matches what you said"`
   - `"shares keywords"`
   - `"mentions <entity label>"`
   - `"part of your profile"`
   - `"pinned core memory"`
   - `"linked via <label> (<edge type>)"`
   - `"linked memory"`

   `similarity` is the blended vector similarity for vector seeds (else 0). The result also reports `seeds` (count), `considered` (nodes that got activation) and `tookMs`.

Recall is a brute-force scan over the cached vectors plus a few indexed queries; the test suite keeps a 10k-node net with edges under 200 ms.

## Write path: `observe(turn)`

Core calls it after every **completed** turn of a non-incognito conversation, off the critical path. Failed and cancelled turns are not observed. The service runs `observe` calls **one at a time** (a queue), so episode order, dedupe and entity upserts stay coherent. It never throws: errors are logged and returned as `skipped: 'memory error'`.

1. `policy.mode === 'off'` → `skipped: 'memory is off'`.
2. **Texts**:
   - **User text**: the text parts of the user message plus `describeUiEvent` for `ui_event` parts. Never the `context` part (recalled memories).
   - **Assistant text**: the text parts of the reply.

   Each is truncated to `maxTurnTextChars` (4,000). An empty user text → `skipped: 'nothing to remember'`. **Tool outputs are never read** (protection against memory poisoning), with one exception: the `id` returned by NEO's own `remember` tool, and the memory ids returned by its `recall` tool. They are only used to look memories up in the net (see same-turn dedupe and NEO-07 below).
3. **Extraction**: with a memory model, unless the turn must stay off the cloud (NEO-07); otherwise, or when the model call fails or its reply is unusable, the **offline extractor**.
   - **Model path**: one `chat` call with `system = EXTRACTION_PROMPT` (below), `responseFormat: 'json'`, `temperature: 0`, `maxTokens: 1500`, `metadata: { purpose: 'memory-extract' }`, and a hard timeout of `llmTimeoutMs` (90 s) so a hung model can't stall the write queue. The memory model is `settings.memoryModel ?? settings.defaultModel` (else the first enabled provider's default model), resolved on every call. Its `isLocal` comes from the provider adapter.
   - **Related memories** given to the model: first, the memories the `remember` tool wrote in this turn, so the model reinforces them instead of creating them again. Then `recall({ text: userText, limit: 10, reinforce: false, allowSensitive, now })`, where `allowSensitive = llm.isLocal || policy.sendSensitiveToCloud` (no `conversationId`). Sensitive memories are filtered from both lists unless `allowSensitive`. At most 10 are listed.
   - **Input format** (the user message of the call; five sections separated by a blank line):

     ```text
     Existing related memories (id | kind | label | content):
     - mem_… | fact | <label on one line> | <content on one line, ≤ 500 chars>
     …                                              (or "Existing related memories: none")

     Blocked topics (never store): <topics, comma-separated, or "none">

     Allowed memory kinds: <kinds, comma-separated>

     Current date: YYYY-MM-DD

     Latest exchange:
     User: <user text>
     NEO: <assistant text>
     ```

     In the exchange, line endings are normalized and **every continuation line is indented by two spaces**. So a line starting with `User: ` or `NEO: ` is always a speaker marker: a reply that itself contains `"\nNEO: "` can't be mistaken for one. The demo brain in `@neo/providers` parses this format.
   - **Reply parsing**: the first JSON object in the reply, read leniently: inside a ```` ```json ```` fence, or after prose, skipping stray braces and braces inside strings, with trailing commas tolerated (up to 64 candidate objects tried). The reply must have the documented shape, meaning a `memories` array or an `episode` key (null counts). Otherwise it is a failed extraction and the offline extractor runs. Each operation and link is validated on its own with zod, and invalid ones are dropped. An invalid *optional* field (importance, sensitivity, entities, tags, entityType, validUntil, a supersede's kind, an episode's label or summary) is dropped instead of failing the operation. Limits:
     - label ≤ 300, content ≤ 10,000, entityType ≤ 40 characters;
     - entities ≤ 20 names of ≤ 120 chars, tags ≤ 20 of ≤ 60, both deduplicated;
     - importance clamped to `[0, 1]`;
     - episode label ≤ 80, summary ≤ 600;
     - `validUntil` as an ISO string or epoch ms.

     Create kinds are fact, preference, entity, skill or goal. A supersede `kind` may also be `summary`; absent or invalid means the old node's kind. Link types are `related`, `causes`, `part_of` or `contradicts`.
4. **Filters** (always, also on model output):
   - **Labels** are cleaned into titles: double quotes removed, punctuation stripped at both ends. If nothing is left, the label is derived from the content.
   - **create**: dropped when `validUntil ≤ now`, when its kind isn't in `allowedKinds`, or when its label, content, entities or tags mention a blocked topic or contain a secret.
   - **update**: dropped on a blocked topic or secret in its label or content.
   - **supersede**: the same, and also when it names a kind outside `allowedKinds`.
   - **reinforce**: dropped when it targets a memory the `remember` tool wrote in this turn (it is already as strong as this turn makes it).
   - **Episode**: kept only if the extractor returned one, `policy.storeEpisodes` is set, `episode` is an allowed kind, the user text mentions no blocked topic, and its label and content pass the topic and secret filters.
   - If no episode, op or link is left: `skipped: 'blocked topic'` when the user text mentions one, else `'nothing worth remembering'`.

   See [Text rules](#text-rules) for blocked topics and secrets.
5. **Embeddings**, before the transaction: the episode text, every create/update/supersede text and every new entity name are embedded where the resulting memory may go (`keepLocal`, using the status the write will have and the sensitivity it will end up with). A failed embedding leaves the vector for background re-embedding.
6. **Apply in one transaction**. `status = policy.mode === 'approve' ? 'pending' : 'active'`. `source = { by: 'extraction', conversationId, messageId: <user message id> }`.
   - **episode** (first):
     - `label` = the cleaned label (≤ 80; derived from the summary or user text if empty);
     - `content` = the model's `summary` or, without one, **only the user's words**: `"User: <user text>"` (UI-event tags removed, whitespace collapsed, ≤ 600 chars). NEO's reply is never stored in an episode, so its wording doesn't become recallable text;
     - `importance` defaults to 0.3, `confidence = extractionConfidence`, `S = S₀`;
     - **sensitive** when the turn is, that is when any of these holds:
       - the turn touched a sensitive memory: the user message's context part is flagged `sensitive: true`, the `remember` tool stored a sensitive memory in it, or the `recall` tool returned one;
       - the user text, or the episode's own label or content, looks sensitive (`looksSensitive`, see [Text rules](#text-rules));
       - any create/update/supersede op of the turn is sensitive, or an update/supersede targets a sensitive memory;
       - an op merged into a sensitive memory. This is only known inside the transaction, so the episode is raised to sensitive there and its vector moves to the device.

       So "I've been seeing a therapist for my depression since March." gives a sensitive episode even without a memory model: it is recalled only with `allowSensitive` and embedded on the device while the main embedder is remote.

     It gets a `precedes` edge (weight 1) from the latest earlier non-superseded episode of the same conversation.
   - **create** `{kind, label, content, importance (0.5), sensitivity?, entities?, entityType?, tags?, validUntil?}`: first the **same-turn check** (below), then the [create path](#the-create-path) with `confidence = extractionConfidence` (0.8), the episode as provenance, and `status`.
   - **update** `{id, label?, content, reason?, sensitivity?}`: the node must exist and be active or pending. In approve mode, an update of an *active* memory becomes a **pending revision** (see [Approve mode](#approve-mode-in-depth)). Otherwise it is applied in place:
     - label and content are set;
     - `confidence = min(1, c + 0.05)`;
     - `sensitivity = stricter(old, op)` (an update can make a memory sensitive, never less sensitive);
     - the node is reinforced and re-embedded.
   - **supersede** `{id, kind?, label, content, reason?, sensitivity?}`: the old node must exist and not be superseded. A **revision** is created (no dedupe against the old one):
     - `kind = op.kind ?? old.kind`;
     - importance, tags and pin are copied from the old node, its entity type when the revision is an entity, and its aliases when both are entities;
     - `confidence = extractionConfidence`, `S = S₀(kind, old.importance)`;
     - `sensitivity = stricter(old, op)`;
     - `metadata.reason` holds the reason (≤ 500 chars).

     It gets a `new —supersedes→ old` edge (1.0), copies of the old node's outgoing `about` edges (with their weights), and `derived_from` the episode (0.5). When `status` is active, the old node becomes `superseded` right away with `confidence × 0.5`. In approve mode the revision is pending and the old belief is untouched (see below).
   - **reinforce** `{id}`: reinforcement, active nodes only.
   - **links** `{from, to, type, weight?}`: each endpoint resolves, in order, to:
     1. a node touched in this turn (by id or normalized label);
     2. any non-superseded node by id;
     3. an entity by name or alias.

     The edge is added unless it (or, for symmetric types, its reverse) exists or it is a self-loop. Default weight 0.5.
7. Return `MemoryWriteResult`:
   - `created`: new active nodes, including the episode;
   - `pending`: new pending nodes and revisions;
   - `updated`: merges and in-place updates;
   - `superseded`: old beliefs replaced in auto mode;
   - `linked`: the number of links added.

   After commit, `onChange` emits `created`, `pending`, `updated` and `deleted` with the node ids, and core broadcasts `memory.written`.

**Same-turn dedupe against `remember` tool writes.** When the user says "Remember that I'm vegetarian", the chat model often calls `remember` during the turn, and extraction then sees the same fact again. A memory the `remember` tool wrote in this turn (an `id` from a successful `remember` tool result, still active or pending) **is** the memory an extracted `create` restates when:

- the kinds match (fact and preference count as one), **and**
- either:
  - the label or the content overlaps. Both are normalized (NFKC, lower case, punctuation and symbols as spaces) and are equal, or one contains the other as whole words (as a substring for CJK), provided the contained text is *substantial*: ≥ 6 characters, or ≥ 3 CJK characters ("vegetarian", "喜欢喝茶"; not "tea");
  - or the tool memory has a vector of the same model as the create's (main, or `local-hash2-512` for text kept on the device) and the two have `cos ≥ turnDedupeSimilarity` (0.8). Vectors of different models are never compared, even with equal dimensions.

This rule is deliberately looser than `dedupeSimilarity`: within one turn, both say what the user just said. No second memory is created. The extracted entities (`about` edges) and the `derived_from` edge to this turn's episode are added to the tool's memory instead. **Sensitivity only goes up**: when the extracted create is sensitive and the tool's memory isn't, the tool's memory becomes sensitive (it is then listed in `updated`), and its vector moves to the device while the main embedder is remote.

### The create path

Shared by `observe`, `remember` and consolidation (`createOrMerge`).

1. **Target**: a create of kind `entity` first looks for an entity with that name (`norm_label` or an alias, case-insensitive, preferring active over pending/archived and older over newer, never superseded). Otherwise, **dedupe**: the active or pending node of the same kind with the highest `cos ≥ dedupeSimilarity` (0.92) in the same vector space, or, failing that, one with the same normalized label *and* content.
2. **Merge** into the target:
   - reinforce it;
   - `importance = max`, `confidence = max`;
   - **sensitivity raised** to sensitive if the incoming write is sensitive.

   When the target may be edited, also:
   - replace its content unless the new text adds nothing (empty, equal, the `Entity: <name>` placeholder, or already contained in the old content), and re-embed it **where the merged memory belongs**: the incoming vector was computed where the *write* belongs, so it is stored only when that is the same space; otherwise the node is re-embedded in the background (a normal restatement that replaces a sensitive memory's content is re-embedded on the device);
   - pin it if the write pins;
   - union the tags (≤ 20);
   - set an entity's type if it had none;
   - set `validUntil`.

   The target may be edited unless the write is pending and the target isn't. In approve mode, a merge into an active memory only reinforces it, and raises importance, confidence and sensitivity. An active write that merges into a pending memory approves it, and into an archived one restores it.
3. **Insert** otherwise:
   - `stability = S₀` and `status` as given;
   - `entityType` only for entities;
   - tags ≤ 20, `validUntil` and `metadata` as given;
   - a vector in the right space.
4. **Entities and provenance** (also after a merge): for each name in `entities` (except an entity's own name), the entity is upserted by name or alias. A new entity gets:
   - importance 0.5, `confidence = extractionConfidence`, `S₀(entity, 0.5)`, content `"Entity: <name>"`;
   - `entityType` from the write (for non-entity creates);
   - **sensitive** if the write or the node is sensitive;
   - **pending** if the incoming write is pending or the node is pending, else active.

   The status comes from the *incoming write*, never from the node it merged into. An existing pending entity named by an active write is activated. Then the edges are added:
   - `node —about→ entity` (0.8);
   - `episode —mentions→ entity` (0.6), when there is an episode;
   - `node —derived_from→ episode` (0.5, or the caller's weight), when there is an episode.

### EXTRACTION_PROMPT

Copied from `extract.ts`:

```text
You are the memory of a personal AI assistant called NEO. Decide what is worth remembering long-term from the latest exchange between the user and NEO.

Remember: stable facts about the user and their world (people, places, pets, work, projects), preferences and dislikes, goals and plans, skills/procedures they teach, and important events. Write each memory as a short self-contained statement in the third person ("The user's sister is Mia, a nurse in Berlin").
Do NOT remember: small talk, things NEO said that the user didn't confirm, one-off requests ("what's 2+2"), content from web pages or tools, secrets/passwords/API keys, or anything in the blocked topics.
Prefer updating or superseding an existing memory over creating a duplicate. Use "supersede" when the new information contradicts the old (it keeps history). Use "reinforce" when the exchange simply confirms an existing memory.
Mark health, finances, sexuality, religion, politics, exact addresses and identity numbers as "sensitive" (also on an update or supersede that adds such details).
importance: 0.9+ core identity & critical (allergies, names of close people), 0.6–0.8 durable preferences/goals, 0.3–0.5 minor details.
Return ONLY a JSON object:
{"episode": {"label": string, "summary": string, "importance": number} | null,
 "memories": [
   {"op": "create", "kind": "fact"|"preference"|"entity"|"skill"|"goal", "label": string, "content": string, "importance": number, "sensitivity"?: "normal"|"sensitive", "entities"?: string[], "entityType"?: string, "tags"?: string[], "validUntil"?: string|null}
 | {"op": "update", "id": string, "label"?: string, "content": string, "reason": string, "sensitivity"?: "normal"|"sensitive"}
 | {"op": "supersede", "id": string, "kind": string, "label": string, "content": string, "reason": string, "sensitivity"?: "normal"|"sensitive"}
 | {"op": "reinforce", "id": string}],
 "links": [{"from": string, "to": string, "type": "related"|"causes"|"part_of"|"contradicts", "weight"?: number}]}
Set "episode" to null for trivial exchanges (greetings, thanks, quick lookups).
```

### Offline (heuristic) extraction

Used without a memory model, for turns kept off a cloud model (NEO-07), and when the model call fails or its reply is unusable. Deliberately conservative: a missed memory costs little, a wrong one makes NEO feel broken.

- **Questions never create memories.** UI-event blocks are removed, the text is split into sentences, and every question is dropped before any rule runs. A sentence is a question if it ends in `?`/`？`; or, for English, if it starts with a question word or auxiliary (what, who, where, do, can, is, …); or, for Chinese, if it ends in 吗/么/呢 or contains 什么/谁/哪里/怎么/为什么/….
- **Rules** (each produces a clean title and a third-person statement):

  | Pattern | Memory | Importance |
  |---|---|---|
  | "my name is X" / "I'm called X" / "call me X" | entity (person), "The user's name is X." | 0.9 |
  | "I'm N years old" | fact | 0.6 |
  | "I live in / I'm from / I'm based in" | fact | 0.6 |
  | "I work at / for / as" | fact | 0.6 |
  | "I'm a/an <profession>" | fact | 0.6 |
  | "I (really) like / love / enjoy / prefer / adore …" | preference, e.g. "Prefers window seats" | 0.5 |
  | "I hate / dislike / can't stand / don't like …" | preference | 0.5 |
  | "remember that / please note …" | fact, e.g. "The user is vegetarian." | 0.7 |
  | "I'm allergic to X" | fact, **sensitive** | 0.9 |
  | "I have / I've been diagnosed with <condition>" | fact, **sensitive** | 0.8 |
  | "my sister / boss / cat … is (named) X" | fact + entity X (person or pet) | 0.8 |
  | "my goal is to / I plan to / I want to <learn, visit, …>" | goal | 0.6 |
  | 我叫 / 我的名字是 | entity (person) | 0.9 |
  | 我喜欢 / 我不喜欢 / 我住在 / 请记住 | preference / fact | 0.5–0.7 |
  | 我对X过敏 | fact, **sensitive** | 0.9 |
- **Episodes are labeled with what the user did** (an intent label), not with what they said. Greetings, thanks and acknowledgements around the text are ignored. The label is:
  - "Introduced themselves" / "做了自我介绍" when a name was learned;
  - otherwise "Said they …" / "说…" from the first extracted memory ("Said they love hiking");
  - "Asked for a reminder to …" / "要求提醒" for reminder requests;
  - otherwise a title from the first remaining statement, but only if the statements (questions removed) are ≥ `episodeMinChars` (15) characters, or ≥ `episodeMinCharsCJK` (6) when they contain Han characters.

  Otherwise there is no episode: greetings, thanks, questions (including "what do you remember about me?") and very short texts leave nothing. The episode's content is the user's text only (`"User: …"`), importance 0.3.

## `remember(input)` and `update(id, patch)`

`remember` is explicit memory, from the memory UI (`source.by === 'user'`) or the model's `remember` tool (`source.by === 'tool'`, the default). The input is validated (`RememberInputSchema`).

- Mode `off` → `NeoError('forbidden')` for every source.
- `content` is trimmed and must be non-empty. `label = label?.trim() || deriveLabel(content)`, ≤ 300 chars. `kind` defaults to `fact`.
- **Secrets** in the label, content, entities or tags are always refused with `bad_request`.
- **From the tool**:
  - a blocked topic → `forbidden`;
  - a kind outside `allowedKinds` → `forbidden`;
  - status `pending` in approve mode.
- **From the user**: always active, and the blocked-topic and allowed-kind checks are skipped, because it's the user's own edit.
- **Sensitivity**: `sensitive` when the input says so, or when the label, content or tags look sensitive (`looksSensitive`: health, finances, identity documents, …), else `normal`. An explicit `normal` only wins when it comes from the user (`source.by === 'user'`, the memory UI): the model's `remember` tool can raise sensitivity, never lower it. So a tool call that stores "The user takes insulin for type 1 diabetes" without `sensitivity` stores a sensitive memory, embedded on the device while the main embedder is remote.
- The write goes through [the create path](#the-create-path) with:
  - `importance` defaulting to 0.8 and `confidence = userConfidence` (0.95);
  - `pinned`, `entities`, `entityType`, `tags` and `validUntil` as given.

  A duplicate merges into the existing memory and reinforces it.

`update(id, patch)` (memory UI): `MemoryNodePatchSchema` validates the patch (label, content, kind, entityType, aliases, tags, importance, confidence, pinned, sensitivity, `status: active|archived`, validUntil).

- Secrets in the label, content, aliases or tags → `bad_request`.
- A text change re-embeds where the edited memory now belongs.
- `status: 'active'` on a pending memory is an **approval**.
- Restoring an archived memory sets `lastAccessedAt = now`.
- The user may raise or lower sensitivity. The vector then moves to the right space.

## Approve mode in depth

With `policy.mode === 'approve'`, nothing new becomes part of the active net without the user's OK:

- **New memories are pending**: extracted creates, episodes, facts and summaries from consolidation, and `remember` calls from the tool. Pending memories are never recalled. While the main embedder is remote, they are embedded on the device only.
- **Entities follow the incoming write.** An entity created for a pending write is pending, even when the write deduped into an *active* memory. So approve mode never creates active entities.
- **Merges don't edit active memories.** A pending write that dedupes into an active memory only reinforces it, and raises its importance, confidence and sensitivity. It never changes its content, tags, pin or expiry. A merge into another pending memory edits that pending memory in place.
- **Pending revisions.**
  - An extracted `update` of an active memory, or a `supersede` of any memory, creates a new pending node with `metadata.supersedes = <old id>` and the `supersedes` edge. The old belief stays active and unchanged.
  - An `update` of a memory that is itself pending is applied in place.
- **Not gated**: extracted `reinforce` ops and `links` apply immediately.
- **`approve(ids)`** (also `update(id, {status: 'active'})` and the inline memory card), for each pending node:
  1. It becomes active.
  2. A revision drops `metadata.supersedes` and applies the supersession now: the old node becomes `superseded`, with `confidence × 0.5`.
  3. Its vector moves to the main embedder if it no longer has to stay local.

  Then every pending entity linked to an approved node becomes active once **every** node linked to it is active.
- **`reject(ids)`**:
  1. The pending nodes are hard-deleted. A rejected revision leaves the old belief untouched.
  2. Their pending entity neighbors are deleted when nothing links to them any more, and activated when everything still linked to them is active.
  3. Like `forget`, the same transaction **redacts the dream journal**: the lines that name a deleted memory (a rejected one, or an orphaned entity deleted with it) are rewritten into the neutral form (see forget). Consolidation output in approve mode is pending, so this is how a rejected "Learned: …" line loses its text.

## Consolidation: `consolidate()`

`consolidate({ now?, force?, signal? })`.

- **Single-flight**: while a run is in flight, every call (forced or not) returns that run's promise.
- **Memory off**: when `policy.mode` is `off`, every call, forced ("Consolidate now") or not, returns a report with id `'skipped'` and the note "Skipped: memory is off". Nothing is re-embedded, archived, pruned, linked, merged or abstracted, and nothing is journaled: with memory off, nothing is written.
- **Not forced**: returns a report with id `'skipped'` (not journaled) when `policy.consolidation.enabled` is false ("Skipped: consolidation is turned off"), or when less than `policy.consolidation.intervalHours` (default 6) has passed since `lastConsolidationAt` ("Skipped: too soon since the last consolidation").
- **Forced** ("Consolidate now"): ignores both checks.
- **Server timer**: checks every 15 minutes, and runs when consolidation is enabled and the interval has passed since `lastConsolidationAt ?? 0`.

Each run emits `consolidated` with the ids it changed.

Steps, in order:

0. **Re-embed** stale vectors (awaited).
1. **Fade**: active non-entity nodes become `archived` (`updated_at = now`):
   - **expired** ones (`valid_until < now`), even when pinned or important;
   - **faded** ones: unpinned, `importance < archiveMaxImportance` (0.7) and `R < archiveRetention` (0.05).

   Archived memories are not recalled, but stay searchable and restorable.
2. **Prune**: delete non-structural edges with `w_eff < edgeFloor` (0.02). `edgesDecayed` counts the surviving non-structural edges whose `w_eff < 0.999 × w`.
3. **Discover links**: for the active or pending nodes updated since the last completed run (all on the first run; at most 500, most recent first), add `similar` edges (weight `min(1, sim)`) to the top `similarLinksPerNode` (3) **active** nodes in the same vector space with `sim ≥ similarLinkThreshold` (0.8), skipping nodes already linked to it by any edge.
4. **Merge entities**: active or pending entities, oldest first. A newer entity `b` merges into an older `a` when their entity types don't conflict (both set and different → never) and they either share a normalized name (label or alias) or have main-model vectors with `cos ≥ entityMergeSimilarity` (0.95). The merge:
   - moves `b`'s edges to `a`. A duplicate edge is combined into one with the max effective weight and summed coactivations, and self-loops are dropped;
   - sets `a.aliases = a.aliases ∪ {b.label} ∪ b.aliases` (≤ 20);
   - takes `b`'s content if `a`'s is the placeholder, or appends it when it adds something;
   - unions the tags and takes the max of importance, confidence and stability;
   - sums `accessCount` and takes the latest `lastAccessedAt`;
   - pins if either is pinned;
   - makes the result **sensitive if either was**, and active if either was;
   - deletes `b`.

   Survivors are re-embedded where they belong.
5. **Abstract episodes** (only with a memory model):
   1. **Select**: unconsolidated episodes that are active, or that the fade step archived in this same run (like sleep, consolidation learns from the day's experiences before they're gone). Sensitive episodes are included **only** when the model is local or `sendSensitiveToCloud`.
   2. **Cluster** greedily in time order. An episode joins the first cluster whose centroid (sum of main-model vectors) has `cos ≥ consolidationClusterThreshold` (0.75) with it, or with which it shares an entity (`mentions`/`about` target).
   3. **Choose clusters**: those of ≥ 2 episodes, or a single episode older than `singleEpisodeAbstractDays` (7), at most `maxClustersPerRun` (20) per run, oldest first.
   4. **Ask the model** once per cluster (`CONSOLIDATION_PROMPT` below, JSON mode, `temperature: 0`, `maxTokens: 1000`, `metadata.purpose = 'memory-consolidate'`, the same 90 s timeout, the run's abort signal). The user content lists the blocked topics, the allowed kinds and the episodes as `- [YYYY-MM-DD] <label>: <content ≤ 600 chars>`.
   5. **Filter the reply**: a summary is kept only if `summary` is an allowed kind; facts must be an allowed kind (fact, preference, skill or goal). Anything mentioning a blocked topic or containing a secret (in label, content or entities) is dropped.
   6. **Store** each item **through the create path**, so the usual dedupe and merging, entity upserts and vectors in the right space apply:
      - `confidence = extractionConfidence`, importance defaulting to 0.5;
      - `status` pending in approve mode;
      - **sensitive if any episode of the cluster was** (or the fact is marked so);
      - `source = { by: 'consolidation', note: 'Abstracted from N conversation(s)' }`.

      Each item gets `derived_from` edges to every episode of the cluster (summary 0.7, facts 0.5), and the episodes get `consolidated_at = now`.
   7. **Parse failures**: if the call throws or times out, or the reply doesn't have the documented shape (an object with a `summary` key or a `facts` array), the cluster is skipped with a warning and its episodes stay unconsolidated for the next run. In a well-formed reply, invalid facts or an invalid summary are dropped individually. A valid reply with nothing in it still marks the episodes consolidated ("nothing lasting").
6. **Journal**: the report is saved to `memory_journal`. If the run completed, `lastConsolidationAt = now` (the run's start) is written to `memory_meta`.

**Report**: `archived`, `edgesDecayed`, `edgesPruned`, `linksCreated`, `entitiesMerged`, `episodesConsolidated`, `factsCreated` (new non-summary items) and human-readable `notes`:

- "Archived 3 faded memories, e.g. 'Lunch at Joe's', …" (and "… expired memories …");
- "Let go of 5 faded links between memories";
- "Noticed 2 new similarities between memories";
- "Merged 'Mia Chen' into 'Mia'";
- "Learned: Richard prefers window seats (from 3 conversations)", for each new item;
- "Consolidated 4 episodes into 2 new facts";
- "Nothing needed tidying up — your memory is in good shape", when there's nothing else.

Lines that name memories store those memories' ids in a private `noteRefs` map next to the report (see forget). `journal(limit = 20)` returns reports newest first, without `noteRefs`.

**Abort semantics**: the signal is checked before every step, inside the link, merge and abstraction loops, and is passed to the model call.

- Aborted **before the run starts**: nothing changes, nothing is journaled, and the report says "Stopped before starting: consolidation was cancelled".
- Aborted **later**: the work already done is kept and journaled, with its counts and notes (links created before an abort inside link discovery count in `linksCreated`), plus "Stopped early: consolidation was cancelled", but `lastConsolidationAt` is **not** updated, so the next run starts over.
- A step that throws rejects the whole run (no journal entry). The single-flight slot is always released.

### CONSOLIDATION_PROMPT

Copied from `consolidate.ts`:

```text
You are the memory of a personal AI assistant called NEO. While the user is away you consolidate recent conversation episodes into lasting knowledge, the way sleep turns experiences into memories.
From the episodes below, return:
- "summary": one short self-contained third-person statement of what these episodes have in common, or null when they share nothing lasting;
- "facts": durable facts, preferences, skills or goals about the user and their world that the episodes clearly support, each a short self-contained statement in the third person.
Never invent what the episodes do not support. Never include secrets or anything in the blocked topics. Mark health, finances, sexuality, religion, politics, exact addresses and identity numbers as "sensitive".
importance: 0.9+ core identity & critical, 0.6–0.8 durable preferences/goals, 0.3–0.5 minor details.
Return ONLY a JSON object:
{"summary": {"label": string, "content": string, "importance": number} | null,
 "facts": [{"kind": "fact"|"preference"|"skill"|"goal", "label": string, "content": string, "importance": number, "sensitivity"?: "normal"|"sensitive", "entities"?: string[]}]}
```

## Other operations

- **search** `{query?, kinds?, status?, tags?, pinned?, limit (20, ≤ 500), offset, sort?}`:
  - The default status filter is `active` + `pending`. Tags match exactly, case-insensitively.
  - With a query, it runs a hybrid FTS + vector search, `relevance = 0.5·lexical_norm + 0.5·max(0, sim)`:
    - the FTS side ORs the query's non-stopword words, ranked by bm25 and normalized against the best hit (top 1,000);
    - the vector side compares the query embedded in each space, and a vector-only match needs `sim ≥ seedSimilarityFloor` (0.2).
  - Sorts: `relevance` (the default with a query), `recent` (`updated_at`, the default without one), `importance`, or `strength` (`importance × R`).
  - Returns `{items, total}`.
- **get(id)**: the node, its current retention, its edges and neighbor summaries, and its `history`: the older versions it superseded, newest first, following `supersedes` edges (≤ 50).
- **graph**:
  - With `centerId`: a BFS over edges in both directions to `depth` (default 2, ≤ 4). The center plus up to `limit − 1` (default limit 150, ≤ 1000) visible nodes, ranked by `importance × R`.
  - Without a center: the top `limit` visible nodes by `importance + R + min(degree, 10)/10`.
  - Visible means `active` and `pending`; `archived` and `superseded` only with `includeArchived`.
  - Edges among the returned nodes. Nodes carry `retention`.
- **findForForget(query, limit = 20)**: searches active, pending and archived memories:
  - an entity named in the request (whole word, ≥ 2 chars or CJK) scores 2;
  - memories `about` that entity score 1.5 ("forget everything about Mia");
  - direct matches (an FTS hit on a meaningful word, with forget phrasing like "forget", "everything" and "memories" ignored, or `sim ≥ forgetSimilarity` (0.35)) score `0.5·lexical + 0.5·sim`.
- **forget(ids)**: a hard delete of the nodes **and each node's superseded history** (recursively, every `superseded` node it `supersedes`), with their edges, vectors, FTS rows and cache entries. Gone for good. The same transaction **redacts the dream journal** so their text doesn't outlive them:
  - every journal line whose `noteRefs` names a forgotten id is rewritten into a neutral form, keeping the counts ("Archived 3 faded memories (one of them was later forgotten)", "Learned something you later asked me to forget (from 2 conversations)", "Merged two entries about something you later asked me to forget");
  - reports written before `noteRefs` existed are redacted by matching the label in their "Archived / Learned / Merged" lines.
- **link / unlink**: `link(from, to, type, weight?)` validates the type, refuses self-loops and requires both nodes. An existing edge (either direction for symmetric types) is returned, or re-weighted when `weight` is given. A new one defaults to 0.5. `unlink(edgeId)` deletes one edge.
- **export / import**: `MemoryExport` (format `neo-memory`, version 1) with every node and edge. `embeddings` (nodeId → base64 little-endian Float32) are optional and only include main-model vectors.
  - Import validates the whole file.
  - `merge` skips existing ids, and edges that are self-loops, duplicates, or whose endpoints are missing (all counted as `skipped`).
  - Vectors are kept only when the export's `embeddingModel` equals the current embedder's id. Otherwise the nodes are re-embedded.
  - `replace` wipes nodes, edges, vectors and FTS first (not the journal).
  - Imported nodes keep their status and sensitivity. Import doesn't apply the extraction filters.
- **stats**: counts by kind and status, edges, pending, `lastConsolidationAt`, and the main embedder's id.
- **policy**: the server passes `settings.memory` at startup and on every settings change (`setPolicy`). An invalid policy is logged and validated **field by field** with `MemoryPolicySchema`: every valid field is kept and every invalid one falls back to its default. In `consolidation` each sub-field is checked on its own, in `blockedTopics` and `allowedKinds` invalid entries are dropped (one bad entry never clears the other blocked topics), and unknown fields are dropped. Switching `sendSensitiveToCloud` moves sensitive vectors between the spaces (see [re-embedding](#embeddings-and-vector-spaces)).
- **onChange**: emits `created | updated | deleted | pending | consolidated` with node ids, after commit. A throwing listener doesn't affect writes or other listeners. The server forwards them as `memory.changed` events.

## Text rules

- **Normalization** (`normalizeText`, used for `norm_label`, names and topics): NFKC, lower case, whitespace collapsed, trimmed.
- **Whole-word matching** (`containsTerm`): letters, marks, digits and `_` are word characters. The boundary is only checked on sides where the term itself starts or ends with a word character, so "C++" and "Zoë" work. Terms containing Han, Hiragana, Katakana or Hangul match as plain substrings.
- **Blocked topics** (`mentionsBlockedTopic`):
  - The text and each topic are normalized, and blank topics are ignored.
  - A topic matches as whole words, with an English plural suffix (`s`/`es`) allowed after it, so "art" doesn't block "party" and "health" doesn't block "healthy".
  - A single-word English topic also matches its singular ("finances" blocks "finance", "allergies" blocks "allergy").
  - Multi-word topics match as phrases. CJK topics match as substrings.
- **Secrets** (`hasCredentials`), refused on every write path except import:
  - `sk-…` keys (≥ 16 chars), AWS `AKIA…` ids, GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Slack `xox…-` tokens, Google `AIza…` keys and PEM private-key headers;
  - "password / passwd / passcode / passphrase / pwd / pin code" followed by `is`, `was`, `:` or `=`, and the Chinese 密码/口令/密碼 followed by 是/为/:/=;
  - "api key / secret key / access token / auth token" followed by `is`, `:` or `=` and ≥ 8 characters;
  - digit runs of 13–19 digits (single spaces or dashes allowed) that are 15–16 digits long or pass the Luhn check (card numbers).

  Over-blocking is preferred.
- **Sensitive-topic detector** (`looksSensitive`): words about health, finances, identity documents and addresses, sexuality, religion and politics, in English and Chinese. Over-matching is preferred. It decides whether a turn may go to a cloud extraction model (NEO-07), whether a turn's episode is sensitive, and the default sensitivity of `remember`. It never makes an extracted fact sensitive by itself (the model or the offline rules decide that).

## Privacy

Where memory text can leave the device, and what keeps it in:

- **Chat model context**: recall excludes sensitive memories unless `allowSensitive`. Core sets it only when the chat model is local or `sendSensitiveToCloud` is on. Memory tools flag results that expose sensitive memories; assistant messages are flagged when their model actually saw sensitive content. On cloud replay with sharing off, flagged context, tool output and private-derived assistant text, reasoning and tool arguments are withheld while call/result pairing is preserved. Stored messages are unchanged. The same policy excludes private-derived previous replies from recall context and prevents cloud title generation from re-sending a private answer after sharing is revoked. Storage migration v2 backfills legacy assistant flags from existing sensitive context/results. Legacy recall/remember results remain normal when their ids identify existing normal nodes; unknown or deleted memory references and successful forget labels are withheld conservatively because their original sensitivity cannot be recovered. Empty memory results remain normal.
- **Extraction model** (NEO-07): when the memory model is in the cloud and `sendSensitiveToCloud` is off, a **sensitive turn is extracted offline** (heuristics), and the cloud model never sees it. A turn is sensitive when any of these holds:
  - either message or a tool result is flagged `sensitive: true`, even if its source memory has since been forgotten;
  - the user message's context part is flagged `sensitive: true`;
  - the `remember` tool stored a sensitive memory in it;
  - the `recall` tool returned a sensitive memory in it;
  - the user or assistant text looks sensitive;
  - the offline extractor would mark something in it sensitive.

  For turns that do go to a model, the related memories (including the `remember` tool's) are filtered to normal ones unless the model is local or `sendSensitiveToCloud`.
- **Consolidation model**: sensitive episodes are only abstracted by a local model or with `sendSensitiveToCloud`. Knowledge derived from a cluster that contains a sensitive episode is sensitive.
- **Episodes**: the episode of a sensitive turn is sensitive (see the write path), so it is kept away from cloud chat models and cloud embedders like any sensitive memory.
- **Embedder**: while the main embedder is remote, sensitive memories (unless `sendSensitiveToCloud`) and pending memories, and the entity names created for them, are embedded **only** by `local-hash2-512`, in their own vector space. Their vectors are never compared with main-model vectors.
  - When such a memory is approved, or `sendSensitiveToCloud` is switched on, it is re-embedded by the main embedder. Switching it off again moves the sensitive memories back: their main-model vectors stop being used at once, and they are re-embedded by `local-hash2-512`.
  - A memory that becomes sensitive (an update, a merge, a same-turn restatement) moves its vector to the device; a merge never stores a vector computed in the wrong space.
  - The recall `context` (the previous reply) goes to a remote embedder only when sensitive memories aren't in play or are allowed in the cloud. The user's own query text is embedded by the main embedder in every case.
- **Sensitivity only goes up** on automatic paths: an extracted `update` or `supersede`, a merge (create path, same-turn dedupe against a `remember` tool memory, or entity merge), or a new entity attached to a sensitive memory can make a memory sensitive, never normal. The model's `remember` tool can't store sensitive-looking content as normal either. Only the user can lower it, in the memory UI (or by passing `sensitivity: 'normal'` to `remember` from it).
- **Forget** removes nodes, their superseded history, edges, vectors, FTS rows and cache entries, and redacts the dream-journal lines that name them (`noteRefs`).

## Constants

`MEMORY_CONSTANTS` (`constants.ts`):

| Constant | Value | Meaning |
|---|---|---|
| `seedTopK` | `24` | max vector seeds |
| `seedSimilarityFloor` | `0.2` | vector seeds need `sim >` this; also search's vector-only floor |
| `lexicalTopK` | `24` | max keyword seeds |
| `spreadHops` | `2` | spreading-activation hops |
| `spreadDecay` | `0.5` | `D` per hop |
| `minEdgeWeight` | `0.05` | edges below this effective weight don't spread |
| `frontierLimit` | `200` | nodes spreading per hop |
| `pinnedActivationFloor` | `0.3` | activation of pinned "core" seeds |
| `pinnedAlwaysLimit` | `6` | pinned seeds per recall |
| `strengthBase` | `0.5` | strength = base + … |
| `weightRetention` | `0.25` | strength weight of `R` |
| `weightImportance` | `0.15` | strength weight of importance |
| `weightConfidence` | `0.1` | strength weight of confidence |
| `pinnedBoost` | `1.15` | score multiplier for pinned memories |
| `mmrLambda` | `0.7` | MMR relevance vs diversity |
| `dedupeSimilarity` | `0.92` | create-path dedupe threshold |
| `extractionConfidence` | `0.8` | confidence of extracted / consolidated / new-entity memories |
| `userConfidence` | `0.95` | confidence of `remember()` |
| `hebbianRate` | `0.1` | Hebbian learning rate (and initial weight) |
| `hebbianPairs` | `5` | query seeds wired together per recall |
| `stabilityGain` | `1.0` | reinforcement gain |
| `stabilityEpsilonDays` | `0.1` | reinforcement floor (days) |
| `maxStabilityDays` | `3650` | stability cap (days) |
| `archiveRetention` | `0.05` | fade below this `R` |
| `archiveMaxImportance` | `0.7` | … unless importance ≥ this |
| `edgeHalfLifeDays` | `90` | half-life of non-structural edges |
| `edgeFloor` | `0.02` | prune non-structural edges below this |
| `similarLinkThreshold` | `0.8` | `similar` link discovery |
| `similarLinksPerNode` | `3` | `similar` links per changed node per run |
| `consolidationClusterThreshold` | `0.75` | episode clustering (centroid cosine) |
| `maxClustersPerRun` | `20` | clusters abstracted per run |
| `entityMergeSimilarity` | `0.95` | entity merge by vector |
| `profileSeedLimit` | `8` | profile seeds for broad "about me" questions |
| `profileActivation` | `0.35` | their activation |
| `llmTimeoutMs` | `90000` | hard timeout of extraction / consolidation calls |
| `maxTurnTextChars` | `4000` | user / assistant text truncation before extraction |
| `episodeMinChars` | `15` | offline episodes need statements of at least this many characters |
| `episodeMinCharsCJK` | `6` | … or this many when they contain Han characters |
| `singleEpisodeAbstractDays` | `7` | a lone episode older than this is abstracted |
| `forgetSimilarity` | `0.35` | `findForForget` vector threshold |
| `recallContextWeight` | `0.2` | how far the context can nudge similarity up |
| `lexicalMinRelevance` | `0.35` | keyword relevance needed to seed |
| `lexicalMaxActivation` | `0.8` | keyword seed activation at relevance ≥ 1 |
| `lexicalIdfPrior` | `20` | idf smoothing (pseudo-memories without the term) |
| `lexicalMaxDocShare` | `0.5` | in nets of ≥ 20 candidates, ignore terms in more than this share |
| `turnDedupeSimilarity` | `0.8` | same-turn dedupe against `remember` tool writes |

`BASE_STABILITY_DAYS`: episode `3`, fact `30`, entity `90`, preference `60`, skill `45`, goal `14`, summary `30`.

Fixed values in code:

- 64-text embedding and re-embedding batches;
- 10 related memories for extraction;
- extraction `maxTokens` 1500, consolidation 1000;
- the 300-character previous-reply context (core);
- an MMR pool of `max(8 × limit, 64)`;
- edge weights: `about` 0.8, `mentions` 0.6, `derived_from` 0.5 (0.7 for summaries), `precedes` / `supersedes` 1.0, links 0.5 by default;
- entity defaults: importance 0.5, content `"Entity: <name>"`.

## Privacy rules (summary)

| Control | Effect |
|---|---|
| Incognito conversation | No recall and no write-back: core never calls `recall`/`observe` for it, and the context block tells the model so. Its toolset, frozen at the first turn, leaves out the memory tools `remember`, `recall` and `forget`, so the model can't use memory from it either (a call is refused as not available). |
| `mode: approve` | Every new memory is `pending` until approved (inline memory card, Memory → Pending): extracted ones, episodes, entities, revisions of existing beliefs, consolidation output and `remember` tool calls. Pending memories are never recalled and are embedded on the device only. The user's own UI writes are active. |
| `mode: off` | Nothing is written: `observe` writes nothing, `remember` throws `forbidden`, recall neither reinforces nor wires associations, and consolidation is skipped entirely, also when forced (no fading, pruning, linking, merging, abstraction or journal entry). Automatic recall still works unless `recall: false`. |
| `recall: false` | No memories are recalled into the context of new turns, and the model's `recall` tool answers that memory recall is turned off (without recalling). |
| `blockedTopics` | Never stored: the extraction and consolidation models are told the topics, and every extracted or consolidated item and every tool `remember` is filtered (whole words with plurals, CJK as substrings). A user message mentioning one stores no episode. |
| `allowedKinds` | Other kinds are dropped from extraction and consolidation; the `remember` tool gets `forbidden`. |
| `storeEpisodes: false` | No episodes are stored. |
| Secrets | Passwords, API keys and tokens, private keys and card numbers are never stored by extraction, consolidation, `remember` or `update` (the last two answer `bad_request`). Import is not filtered. |
| `sensitive` | Recalled only for local chat models unless `sendSensitiveToCloud`. Never shown to a cloud extraction or consolidation model (sensitive turns are extracted offline). Embedded on the device while the main embedder is remote (also again after `sendSensitiveToCloud` is switched off). Episodes of sensitive turns, and `remember` calls with sensitive-looking content, are sensitive. Sensitivity is only ever raised automatically. |
| Forget | Hard delete of the memories and their superseded history, with edges, vectors and FTS rows. Dream-journal lines that name them are redacted. |
| Reject | Hard delete of pending memories and the pending entities only they used. Dream-journal lines that name them are redacted. |
| Export | Your whole net as JSON, any time (embeddings optional). |
