# Setting up Kattu's chat widget on kattuona.com

The landing page (`index.html`) has a chat widget -- a female Kattu character
bottom-right that visitors can ask about the app. It never talks to an AI
provider directly from the browser. It calls a small Cloudflare Worker (free
tier) in this folder, and *that* holds the real API key and talks to the AI.

Why the extra hop: kattuona.com is a static GitHub Pages site. Anything in
`index.html`'s JavaScript is visible to anyone who opens devtools -- so a key
pasted straight into the page would leak within days. The Worker is the one
piece of this that isn't static, so it's the only safe place for the key to
live.

```
Visitor's browser on kattuona.com
   │  fetch(WORKER_URL + "/chat", {messages: [...]})   ← no key, just the question
   ▼
Cloudflare Worker (this folder)                         ← holds AI_API_KEY as a secret,
   │                                                       rate-limits by IP, adds Kattu's
   │                                                       system prompt
   ▼
Whatever AI_BASE_URL points at                          ← an OpenAI-chat-format API:
                                                            a free-tier provider today,
                                                            your own ai_gateway.py later
```

You don't need to know how Workers work. You do need a free Cloudflare
account and five minutes. Paste the block below into Claude Code (or do it
by hand, following the same steps) from inside `kattuonafitness/ai-widget/worker/`.

## 1. Pick a free-tier AI provider and get a key

Any provider that speaks the OpenAI chat-completions format works -- same
rule the app itself follows (see `api-keys.html`). For a *free* tier right
now, two good options:

- **Groq** (`https://console.groq.com`) -- fast, generous free tier, good
  small models like `llama-3.1-8b-instant`. `wrangler.toml` is already set
  to this by default.
- **OpenRouter** (`https://openrouter.ai`) -- has free-tier models too, base
  URL `https://openrouter.ai/api/v1`.

Sign up, create an API key, keep it somewhere safe for step 4. Don't paste it
into any file in this repo -- it's never committed, only stored as a
Cloudflare secret.

## 2. Install Wrangler (Cloudflare's CLI) and log in

```
npm install -g wrangler
wrangler login
```

This opens a browser to connect your Cloudflare account. If you don't have
one yet, it'll offer to create a free one.

## 3. Create the rate-limit KV namespace

This is what stops one visitor (or a bot) from burning through the whole
free quota alone -- it caps each visitor to `RATE_LIMIT_MAX` questions an
hour (20 by default).

```
cd kattuonafitness/ai-widget/worker
wrangler kv namespace create RATE_LIMIT
```

It prints something like:

```
{ binding = "RATE_LIMIT", id = "abcd1234..." }
```

Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with
that id (keep `binding = "RATE_LIMIT_KV"` as it is -- that name is what
`src/index.js` expects).

## 4. Set the API key as a secret (never in a file)

```
wrangler secret put AI_API_KEY
```

Paste the key from step 1 when prompted. This stores it encrypted on
Cloudflare's side, attached only to this Worker -- it never touches git.

## 5. Check `wrangler.toml` matches your provider

Defaults are set for Groq. If you picked OpenRouter instead, edit the two
lines in `[vars]`:

```
AI_BASE_URL = "https://openrouter.ai/api/v1"
AI_MODEL = "meta-llama/llama-3.1-8b-instruct:free"
```

(Check the provider's docs for their current free-model name -- like the
app's own API-keys page says, these change over time.)

## 6. Deploy

```
wrangler deploy
```

It prints a URL like `https://kattuona-widget-ai.<your-subdomain>.workers.dev`.
That's `WORKER_URL`.

## 7. Point the widget at it

Open `kattuonafitness/index.html`, find `KATTU_WIDGET` near the bottom of the
file (search for `WORKER_URL`), and set:

```js
const KATTU_WIDGET = {
  WORKER_URL: "https://kattuona-widget-ai.<your-subdomain>.workers.dev",
  ...
};
```

Commit and push -- GitHub Pages picks it up automatically.

## 8. Test it

```
curl -s -X POST https://kattuona-widget-ai.<your-subdomain>.workers.dev/chat \
  -H "Content-Type: application/json" \
  -H "Origin: https://kattuona.com" \
  -d '{"messages":[{"role":"user","content":"What does KattuOna track?"}]}'
```

Should come back with `{"reply": "..."}` in a few seconds. Then open
kattuona.com (past the password gate), tap the Kattu bubble bottom-right,
and ask it something for real.

## Switching providers, or to your self-hosted `ai_gateway.py`, later

Nothing to rebuild on the page. Just:

1. `wrangler secret put AI_API_KEY` again with the new key (or reuse one of
   `ai_gateway.py`'s own per-person keys if pointing at that -- see the
   notes at the bottom of `src/index.js` for the one route/shape difference
   it needs).
2. Edit `AI_BASE_URL` / `AI_MODEL` in `wrangler.toml`.
3. `wrangler deploy` again.

`WORKER_URL` in `index.html` doesn't change, so there's nothing to touch on
the page at all.

## Costs and limits, honestly

- Cloudflare Workers free tier: 100,000 requests/day. This widget won't get
  close.
- Workers KV free tier: 100,000 reads + 1,000 writes/day -- also nowhere
  close for a landing-page widget.
- The free-tier AI provider is the real limit: Groq and OpenRouter's free
  tiers both cap requests per minute/day. `RATE_LIMIT_MAX` in `wrangler.toml`
  is there to keep one visitor from eating the whole day's quota; lower it
  if needed.
- None of this costs money unless you deliberately upgrade a plan.
