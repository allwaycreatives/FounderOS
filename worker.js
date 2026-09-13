/**
 * Founder OS Worker
 * ------------------
 * Everything except /api/* is served exactly as before — static assets,
 * SPA fallback to index.html, no behavior change from the assets-only setup.
 *
 * Notion integration (Content Pipeline sync) was removed — that workflow
 * now lives in BrandOS instead. If it ever comes back, this is where a
 * thin reverse-proxy route would go again, following the same pattern as
 * the Google token exchange below.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/google/token" || url.pathname === "/api/google/refresh") {
      return handleGoogleTokenExchange(request, env, url);
    }
    if (url.pathname === "/api/claude/chat") {
      return handleAssistantChat(request, env);
    }
    if (url.pathname === "/api/voice/capture") {
      return handleVoiceCapture(request, env);
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

  const model = "gemini-3.5-flash"; // gemini-1.5-flash was sunset — this matches Google's own current official API reference example as of this writing
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
 * Voice capture ("idea button"). One round-trip that both transcribes an
 * audio memo and suggests which existing business/project it belongs to,
 * so the client only needs a single request and a single confirm step.
 * Same provider-agnostic reasoning as the assistant chat above — Gemini
 * today (already has a working key on this Worker), swappable later.
 * The audio is relayed straight through to Gemini and never stored here
 * or anywhere else server-side.
 */
async function handleVoiceCapture(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.GEMINI_API_KEY) {
    return json(
      { error: "GEMINI_API_KEY is not configured on this Worker. Set it in Cloudflare dashboard > Settings > Variables and Secrets." },
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.audioBase64 || !body.mimeType) {
    return json({ error: "audioBase64 and mimeType are required" }, 400);
  }

  const businesses = Array.isArray(body.businesses) ? body.businesses : [];
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const vocabulary = Array.isArray(body.vocabulary) ? body.vocabulary.filter(Boolean) : [];
  const catalog = [
    ...businesses.map(b => `business:${b.id} — ${b.name}`),
    ...projects.map(p => `project:${p.id} — ${p.name}`),
  ].join("\n");

  // Asking for transcript + classification in the same call (rather than
  // two round-trips) keeps this fast enough to feel instant on a phone.
  const instruction = `Transcribe the attached voice memo exactly, word for word.${vocabulary.length ? ` The speaker runs a business and uses these proper nouns often — if something sounds close to one of these, prefer it over a generic word: ${vocabulary.join(", ")}.` : ""}

Then, using ONLY this list of the founder's businesses and projects, decide whether the memo clearly belongs to one of them:
${catalog || "(none defined yet — always respond with matchType none)"}

Respond with ONLY this JSON object, no markdown fencing, no commentary:
{"transcript": "...", "matchType": "business" | "project" | "none", "matchId": "the id portion after the colon above, or null", "confidence": 0.0 to 1.0}

Only choose a match if the memo clearly names or strongly, unambiguously implies that specific business or project. If there's any real doubt, use "none" and confidence 0.`;

  let geminiResp;
  try {
    geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: instruction },
              { inlineData: { mimeType: body.mimeType, data: body.audioBase64 } },
            ],
          }],
          generationConfig: { maxOutputTokens: 800, responseMimeType: "application/json" },
        }),
      }
    );
  } catch (err) {
    return json({ error: `Couldn't reach Gemini: ${err.message || err}` }, 502);
  }

  const data = await geminiResp.json().catch(() => null);
  if (!geminiResp.ok || !data) {
    return json(
      { error: (data && data.error && data.error.message) || `Gemini request failed (${geminiResp.status})` },
      geminiResp.status || 502
    );
  }

  const candidate = data.candidates && data.candidates[0];
  const raw = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map(p => p.text || "").join("")
    : "";

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Model didn't return clean JSON (rare, but responseMimeType isn't a
    // hard guarantee) — still surface the raw text as the transcript
    // rather than failing the capture outright. An idea with no match is
    // always safe to fall back to.
    parsed = { transcript: raw.trim(), matchType: "none", matchId: null, confidence: 0 };
  }

  return json({
    transcript: parsed.transcript || "",
    matchType: parsed.matchType === "business" || parsed.matchType === "project" ? parsed.matchType : "none",
    matchId: parsed.matchId || null,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
  }, 200);
}

/**
 * In-app Claude assistant. Same reasoning as the Google proxy above —
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

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
