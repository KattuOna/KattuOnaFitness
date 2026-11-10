/**
 * KattuOna landing-page chat widget -- proxy worker.
 *
 * Why this exists: kattuona.com is a static GitHub Pages site. A real API key
 * can't live in that page's JS -- anyone's browser devtools would see it. This
 * Worker holds the key as a Cloudflare secret instead, and is the only thing
 * that ever talks to the upstream AI provider.
 *
 * It also decides WHICH provider to talk to, via the AI_BASE_URL / AI_MODEL
 * vars below -- not the page. That's deliberate: switching from a hosted
 * free-tier API to the self-hosted ai_gateway.py (once it's public, see
 * kattuona-app/ai_server/AI_SERVER_SETUP.md) is a `wrangler secret put` /
 * `wrangler.toml` edit here, never a change to index.html.
 *
 * Upstream contract: anything that speaks the OpenAI chat-completions shape
 * (POST {base}/chat/completions, {model, messages, ...} in, {choices[0]
 * .message.content} out) works -- same convention the app itself documents
 * in privacy.html and uses in Settings -> AI engine -> "Use an API key".
 * ai_gateway.py already speaks a close cousin of this; see NOTES below for
 * the one field it needs instead.
 */

const DEFAULT_ALLOWED_ORIGINS = [
  "https://kattuona.com",
  "https://www.kattuona.com",
  "https://kattuona.github.io",
];

// Kept short on purpose: this answers strangers on a marketing page, not
// signed-in users inside the app. It should sound like Kattu, stay on topic,
// and never pretend to be a doctor, a coach who knows this particular
// visitor, or a human.
const SYSTEM_PROMPT = `You are Kattu, the AI coach character from the KattuOna fitness app -- answering
questions from a visitor on the KattuOna marketing website (kattuona.com), not inside the app itself.
You are friendly, brief, and honest. You have no memory of this visitor and no access to anyone's
real data -- you only know what's on the website.

What KattuOna is: an Android fitness app (workouts & programs, nutrition logging by hand/barcode/photo
with an AI Chef that turns what's in someone's fridge into recipes hitting their targets, sleep &
recovery with automatic sleep detection and a daily readiness check, smaller daily habits like Zone 2
cardio/HIIT/cold & heat exposure, body metrics, a supplements tracker, and a shop tab for gear). It is
still in closed testing, not yet on the Play Store, and has no account or sign-up -- people who want in
early email Kattu0na@gmail.com.

Its whole pitch is "own your data": no analytics, no ads, nothing sent anywhere without being asked.
Every tracking feature works fully with zero AI configured. If someone does want an AI coach, they pick
exactly one of three ways to run it, never KattuOna's own server, because there isn't one: (1) no AI, just
tracking: the default; (2) their own API key, from any provider that speaks the OpenAI chat format (OpenAI,
Groq, Together, Mistral, OpenRouter, DeepSeek, and others) -- entered in Settings -> AI engine, and the
app talks straight to that provider; (3) their own hardware -- a home server, NAS or spare laptop running
an open model like Ollama, which the app can be pointed at instead. Portion logging can be calibrated: a
person weighs their own cup, bowl or spoon with water once, so "one bowl" means an accurate gram figure
for a logged food.

Ground rules:
- Answer only what's asked, in 1-4 short sentences. No long essays, no markdown headers, no bullet lists
  unless the question is a "what are my options" question that genuinely needs one.
- You are not this visitor's coach or doctor. If someone describes an injury, a medical condition, or
  asks for specific training/diet advice for their own body, say plainly that you can't give personal
  medical or training advice here, and that the in-app AI coach (once they're in and have an AI
  configured) is the right place to ask -- or their own doctor for anything medical.
- Only state features that are actually in the app, as described above. If you don't know something --
  pricing beyond "closed testing, email to get in," a release date, something technical you're unsure of
  -- say you're not sure and point to Kattu0na@gmail.com or the privacy policy / self-hosting pages
  linked on the site, rather than guessing.
- Never claim to be human, never claim to remember earlier visitors, never invent a name, injury, or
  personal detail for the person you're talking to.
- If asked something with nothing to do with KattuOna, answer briefly if you can, then steer back:
  you're here to help people understand the app.`;

function corsHeaders(origin, allowedOrigins) {
  const allow = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/** Keep only what we asked the page to send, nothing it didn't: role + content,
 *  user/assistant only, last 8 turns, each capped in length. A visitor's
 *  browser is untrusted input -- this is what stands between it and the
 *  upstream prompt (and the upstream bill). */
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
}

/** Simple fixed-window counter in KV: N requests per IP per hour. KV is
 *  eventually consistent, so this is a speed bump against abuse/quota
 *  drain, not a hard guarantee -- that's fine for a free marketing widget. */
async function isRateLimited(env, ip) {
  if (!env.RATE_LIMIT_KV) return false; // not configured yet -- fail open, see SETUP.md
  const key = `rl:${ip}`;
  const windowMs = 60 * 60 * 1000;
  const max = Number(env.RATE_LIMIT_MAX || 20);
  const now = Date.now();

  let rec = null;
  try {
    rec = await env.RATE_LIMIT_KV.get(key, { type: "json" });
  } catch {
    return false;
  }

  if (!rec || now - rec.start > windowMs) {
    await env.RATE_LIMIT_KV.put(key, JSON.stringify({ start: now, count: 1 }), { expirationTtl: 3600 });
    return false;
  }
  if (rec.count >= max) return true;
  await env.RATE_LIMIT_KV.put(key, JSON.stringify({ start: rec.start, count: rec.count + 1 }), {
    expirationTtl: 3600,
  });
  return false;
}

export default {
  async fetch(request, env) {
    const allowedOrigins = (env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, allowedOrigins);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true }, 200, cors);
    }
    if (url.pathname !== "/chat" || request.method !== "POST") {
      return json({ error: "not found" }, 404, cors);
    }
    if (origin && !allowedOrigins.includes(origin)) {
      return json({ error: "origin not allowed" }, 403, cors);
    }
    if (!env.AI_API_KEY || !env.AI_BASE_URL) {
      // Set by `wrangler secret put AI_API_KEY` / wrangler.toml -- see SETUP.md.
      return json({ error: "The AI isn't set up yet -- try again later." }, 503, cors);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (await isRateLimited(env, ip)) {
      return json(
        { error: "Kattu's had a lot of questions this hour -- try again in a bit." },
        429,
        cors
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad request" }, 400, cors);
    }

    const messages = sanitizeMessages(body.messages);
    if (messages.length === 0) {
      return json({ error: "say something first" }, 400, cors);
    }

    const upstreamBody = {
      model: env.AI_MODEL || "llama-3.1-8b-instant",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      max_tokens: 400,
      temperature: 0.6,
    };

    let upstream;
    try {
      upstream = await fetch(`${env.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.AI_API_KEY}`,
        },
        body: JSON.stringify(upstreamBody),
      });
    } catch {
      return json({ error: "Couldn't reach the AI right now -- try again shortly." }, 502, cors);
    }

    if (!upstream.ok) {
      return json(
        { error: "The AI is unavailable right now -- try again shortly." },
        502,
        cors
      );
    }

    let data;
    try {
      data = await upstream.json();
    } catch {
      return json({ error: "Got a strange reply from the AI -- try again." }, 502, cors);
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      return json({ error: "Didn't get an answer back -- try again." }, 502, cors);
    }

    return json({ reply }, 200, cors);
  },
};

/* NOTES on pointing this at the self-hosted ai_gateway.py later
   (see kattuona-app/ai_server/AI_SERVER_SETUP.md):

   - ai_gateway.py expects its key as `Authorization: Bearer <key>` already --
     matches what this Worker sends, so AI_API_KEY can just be one of its
     per-person keys (make one with `add-key website-widget` so it can be
     revoked on its own).
   - Its chat route is POST {base}/api/chat, not POST {base}/chat/completions.
     Once the gateway is reachable from the public internet (Tailscale Funnel
     or Cloudflare Tunnel, both already covered in that doc), either add an
     OpenAI-shaped alias route to ai_gateway.py, or change the fetch() path
     above to `${env.AI_BASE_URL}/api/chat` and adjust the request/response
     shape to match it. Small change, deliberately not done here since the
     gateway isn't public yet.
   - That machine is a CPU-only laptop: a short lookup is fine, but a full
     chat reply can take 1-3 minutes -- comfortably past what a browser
     widget should sit waiting on. If/when this gets pointed there, the
     widget's timeout and "thinking" copy should be adjusted to match
     (see index.html's KATTU_WIDGET config), or the gateway's smaller/faster
     path used instead.
*/
