/**
 * Founder OS Worker
 * ------------------
 * Everything except /api/* is served exactly as before — static assets,
 * SPA fallback to index.html, no behavior change from the assets-only setup.
 *
 * /api/notion/* is a thin, generic reverse proxy to api.notion.com. The
 * point of this file existing at all: Notion's API has no CORS support, so
 * the browser can never call it directly. This Worker runs server-side
 * (not subject to CORS), holds the one real secret (NOTION_TOKEN, set via
 * `wrangler secret put NOTION_TOKEN` or the Cloudflare dashboard's
 * Variables and Secrets — never committed to this repo, never sent to the
 * browser), and forwards whatever the app asks for.
 *
 * The proxy is intentionally dumb — it doesn't know about Content items,
 * missions, or any app-specific shape. It just injects auth and forwards.
 * All Notion-specific logic (which database, which properties map to what)
 * lives in index.html, where it's far easier to iterate on without
 * redeploying a Worker secret.
 */

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/notion/")) {
      return handleNotionProxy(request, env, url);
    }
    if (url.pathname === "/api/google/token" || url.pathname === "/api/google/refresh") {
      return handleGoogleTokenExchange(request, env, url);
    }
    if (url.pathname === "/api/claude/chat") {
      return handleAssistantChat(request, env);
    }

    // Anything else: behave exactly like the old assets-only deployment.
    return env.ASSETS.fetch(request);
  },
};

/**
 * In-app assistant. Provider-agnostic on purpose — the client (index.html)
 * always sends the same {system, messages} shape and always expects the
 * same {content: [{type: "text", text: "..."}]} shape back, regardless of
 * which real AI provider is behind it. Switching providers is a change
 * entirely contained in this function; the UI never needs to know.
 *
 * Currently wired to Gemini (ASSISTANT_PROVIDER below) — Anthropic's
 * Console required payment details upfront for this account, Gemini has a
 * genuine no-card free tier, so Gemini is first. Switching back to Claude
 * later means: set ASSISTANT_PROVIDER back to "anthropic" and add
 * ANTHROPIC_API_KEY as a Worker secret — nothing else changes.
 */
const ASSISTANT_PROVIDER = "gemini"; // "gemini" | "anthropic"

async function handleAssistantChat(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: "messages array is required" }, 400);
  }

  if (ASSISTANT_PROVIDER === "gemini") {
    return handleGeminiChat(body, env);
  }
  return handleAnthropicChat(body, env);
}

async function handleGeminiChat(body, env) {
  if (!env.GEMINI_API_KEY) {
    return json(
      { error: "GEMINI_API_KEY is not configured on this Worker. Set it in Cloudflare dashboard > Settings > Variables and Secrets." },
      500
    );
  }

  // Gemini's shape differs from Anthropic's: "model" instead of
  // "assistant" for the AI's turns, and a separate systemInstruction field
  // instead of a top-level "system" string.
  const contents = body.messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const model = "gemini-1.5-flash"; // stable/production-ready per Google's own docs, generous free tier
  let geminiResp;
  try {
    geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents,
          systemInstruction: body.system ? { parts: [{ text: body.system }] } : undefined,
          generationConfig: { maxOutputTokens: 1500 },
        }),
      }
    );
  } catch (err) {
    return json({ error: `Couldn't reach Gemini: ${err.message || err}` }, 502);
  }

  const data = await geminiResp.json().catch(() => null);
  if (!geminiResp.ok || !data) {
    return json({ error: (data && data.error && data.error.message) || `Gemini request failed (${geminiResp.status})` }, geminiResp.status || 502);
  }

  // Translate Gemini's response shape into the same envelope the client
  // already expects from Anthropic's Messages API — this is the one place
  // that has to know about the difference.
  const candidate = data.candidates && data.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map(p => p.text || "").join("")
    : "(no response)";
  return json({ content: [{ type: "text", text }] }, 200);
}

/**
 * In-app Claude assistant. Same reasoning as the Notion/Google proxies —
 * ANTHROPIC_API_KEY is a Worker secret, never sent to the browser. This is
 * the founder's OWN Anthropic Console account and billing, separate from
 * (and unrelated to) whatever Claude product built this app.
 */
async function handleAnthropicChat(body, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json(
      { error: "ANTHROPIC_API_KEY is not configured on this Worker. Set it in Cloudflare dashboard > Settings > Variables and Secrets." },
      500
    );
  }

  let anthropicResp;
  try {
    anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1500,
        system: body.system || undefined,
        messages: body.messages,
      }),
    });
  } catch (err) {
    return json({ error: `Couldn't reach Anthropic: ${err.message || err}` }, 502);
  }

  const responseBody = await anthropicResp.text();
  return new Response(responseBody, {

    status: anthropicResp.status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Google OAuth token exchange — the one step that MUST happen server-side.
 * Google's token endpoint requires a client_secret for Web-application-type
 * OAuth clients even when using PKCE, which is exactly why this can't be
 * done from the browser (a secret shipped to the browser isn't a secret).
 * GOOGLE_CLIENT_SECRET is a Worker secret (Settings > Variables and Secrets
 * on the founderos Worker) — never committed to this repo, never sent to
 * the browser. The client_id itself isn't secret, so it's just passed
 * through from the request body.
 */
async function handleGoogleTokenExchange(request, env, url) {
  if (!env.GOOGLE_CLIENT_SECRET) {
    return json(
      { error: "GOOGLE_CLIENT_SECRET is not configured on this Worker. Set it in Cloudflare dashboard > Settings > Variables and Secrets." },
      500
    );
  }
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const params = new URLSearchParams();
  params.set("client_id", body.clientId || "");
  params.set("client_secret", env.GOOGLE_CLIENT_SECRET);

  if (url.pathname === "/api/google/token") {
    if (!body.code || !body.codeVerifier || !body.redirectUri) {
      return json({ error: "Missing code, codeVerifier, or redirectUri" }, 400);
    }
    params.set("code", body.code);
    params.set("code_verifier", body.codeVerifier);
    params.set("redirect_uri", body.redirectUri);
    params.set("grant_type", "authorization_code");
  } else {
    if (!body.refreshToken) return json({ error: "Missing refreshToken" }, 400);
    params.set("refresh_token", body.refreshToken);
    params.set("grant_type", "refresh_token");
  }

  let tokenResp;
  try {
    tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (err) {
    return json({ error: `Couldn't reach Google: ${err.message || err}` }, 502);
  }

  const responseBody = await tokenResp.text();
  return new Response(responseBody, {
    status: tokenResp.status,
    headers: { "content-type": "application/json" },
  });
}

async function handleNotionProxy(request, env, url) {
  if (!env.NOTION_TOKEN) {
    return json(
      { error: "NOTION_TOKEN is not configured on this Worker. Set it in Cloudflare dashboard > Settings > Variables and Secrets." },
      500
    );
  }

  // Only allow a small, known set of Notion endpoints — this is a personal
  // tool's proxy, not a general-purpose passthrough, so keep the surface
  // area deliberately narrow.
  const notionPath = url.pathname.replace(/^\/api\/notion/, "");
  const allowed =
    /^\/databases\/[a-zA-Z0-9-]+$/.test(notionPath) ||
    /^\/databases\/[a-zA-Z0-9-]+\/query$/.test(notionPath) ||
    /^\/pages$/.test(notionPath) ||
    /^\/pages\/[a-zA-Z0-9-]+$/.test(notionPath);

  if (!allowed) {
    return json({ error: "This Notion endpoint isn't allowed through the proxy." }, 403);
  }

  const notionUrl = NOTION_API_BASE + notionPath + url.search;
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${env.NOTION_TOKEN}`);
  headers.set("Notion-Version", NOTION_VERSION);
  headers.set("Content-Type", "application/json");

  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }

  let notionResp;
  try {
    notionResp = await fetch(notionUrl, init);
  } catch (err) {
    return json({ error: `Couldn't reach Notion: ${err.message || err}` }, 502);
  }

  const body = await notionResp.text();
  return new Response(body, {
    status: notionResp.status,
    headers: { "content-type": "application/json" },
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
