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
 *
 * Real push notifications (added for focus/break session reminders):
 * this is genuinely new infrastructure, not just another proxy route.
 * PUSH_KV (a Cloudflare KV namespace, bound in wrangler.jsonc) stores two
 * kinds of records — `subscription:<deviceId>` (a browser's push
 * subscription) and `reminder:<id>` (a scheduled one-off notification) —
 * and the `scheduled` export below runs every minute (see the cron
 * trigger in wrangler.jsonc) to fire any reminder whose time has come.
 * Sending an actual push message means implementing the Web Push
 * protocol by hand with WebCrypto (VAPID JWT signing + RFC 8291 payload
 * encryption) since there's no build step here to pull in the usual
 * `web-push` npm package. See sendWebPush() further down for that.
 */

const VAPID_PUBLIC_KEY = "BPdVV5aL9adUNkAQzoX6c0WL7IZrfNA0mi2d2aHLbRi9dUXFTYryl6B9Lxz5OD9zTXisdI50vV2CJReijm0xXTA";

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
    if (url.pathname === "/api/idea/analyze") {
      return handleIdeaAnalyze(request, env);
    }
    if (url.pathname === "/api/push/subscribe") {
      return handlePushSubscribe(request, env);
    }
    if (url.pathname === "/api/push/unsubscribe") {
      return handlePushUnsubscribe(request, env);
    }
    if (url.pathname === "/api/push/schedule") {
      return handlePushSchedule(request, env);
    }
    if (url.pathname === "/api/push/cancel") {
      return handlePushCancel(request, env);
    }
    if (url.pathname === "/api/push/test") {
      return handlePushTest(request, env);
    }

    // Anything else: behave exactly like the old assets-only deployment.
    return env.ASSETS.fetch(request);
  },

  // Cron trigger (see wrangler.jsonc — runs every minute). Cheap and
  // simple over clever: list every pending reminder, fire the ones that
  // are due, delete them either way. Fine at personal-app scale; would
  // need a smarter index if this were ever handling many users/reminders.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDueReminders(env));
  },
};

/**
 * Push notification endpoints
 */
async function handlePushSubscribe(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await request.json().catch(() => null);
  if (!body || !body.deviceId || !body.subscription) {
    return json({ error: "deviceId and subscription are required" }, 400);
  }
  await env.PUSH_KV.put(`subscription:${body.deviceId}`, JSON.stringify(body.subscription));
  return json({ ok: true });
}

async function handlePushUnsubscribe(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await request.json().catch(() => null);
  if (!body || !body.deviceId) return json({ error: "deviceId is required" }, 400);
  await env.PUSH_KV.delete(`subscription:${body.deviceId}`);
  return json({ ok: true });
}

// Schedules a one-off notification for a future time. Returns an id so the
// caller can cancel it later (e.g. a focus session ends early, or the
// founder marks a task done before the check-in reminder was due).
async function handlePushSchedule(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await request.json().catch(() => null);
  if (!body || !body.deviceId || !body.dueAt || !body.title) {
    return json({ error: "deviceId, dueAt, and title are required" }, 400);
  }
  const id = crypto.randomUUID();
  const ttlSeconds = Math.max(60, Math.ceil((body.dueAt - Date.now()) / 1000) + 60 * 60 * 24); // due time + 1 day safety margin
  await env.PUSH_KV.put(`reminder:${id}`, JSON.stringify({
    deviceId: body.deviceId,
    dueAt: body.dueAt,
    title: body.title,
    body: body.body || "",
    tag: body.tag || undefined,
    url: body.url || "./",
    category: body.category || "generic",
  }), { expirationTtl: ttlSeconds });
  return json({ ok: true, id });
}

async function handlePushCancel(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await request.json().catch(() => null);
  if (!body || !body.id) return json({ error: "id is required" }, 400);
  await env.PUSH_KV.delete(`reminder:${body.id}`);
  return json({ ok: true });
}

// Immediate test send — lets the founder verify the whole pipeline (VAPID
// keys, subscription, KV, actual delivery) works before trusting it for
// real focus-session reminders.
async function handlePushTest(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await request.json().catch(() => null);
  if (!body || !body.deviceId) return json({ error: "deviceId is required" }, 400);
  const subRaw = await env.PUSH_KV.get(`subscription:${body.deviceId}`);
  if (!subRaw) return json({ error: "No push subscription found for this device yet — enable notifications first." }, 404);
  const subscription = JSON.parse(subRaw);
  try {
    const resp = await sendWebPush(subscription, { title: "Founder OS", body: "Test notification — if you see this, push is working.", url: "./", category: "ontrack" }, env);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return json({ error: `Push service rejected the message (${resp.status}): ${text}` }, 502);
    }
  } catch (err) {
    return json({ error: `Push send failed: ${err.message || err}` }, 502);
  }
  return json({ ok: true });
}

async function runDueReminders(env) {
  const now = Date.now();
  const list = await env.PUSH_KV.list({ prefix: "reminder:" });
  for (const key of list.keys) {
    const raw = await env.PUSH_KV.get(key.name);
    if (!raw) continue;
    let reminder;
    try {
      reminder = JSON.parse(raw);
    } catch (e) {
      await env.PUSH_KV.delete(key.name);
      continue;
    }
    if (reminder.dueAt > now) continue; // not due yet, leave it

    // A reminder only ever fires once — remove it now regardless of what
    // happens next, so a delivery failure can't cause it to repeat forever.
    await env.PUSH_KV.delete(key.name);

    const subRaw = await env.PUSH_KV.get(`subscription:${reminder.deviceId}`);
    if (!subRaw) continue; // device unsubscribed since this was scheduled
    const subscription = JSON.parse(subRaw);
    try {
      const resp = await sendWebPush(subscription, {
        title: reminder.title, body: reminder.body, url: reminder.url, tag: reminder.tag, category: reminder.category,
      }, env);
      if (resp.status === 404 || resp.status === 410) {
        // Push service says this subscription is gone for good — stop
        // trying to send to it rather than failing silently forever.
        await env.PUSH_KV.delete(`subscription:${reminder.deviceId}`);
      }
    } catch (e) {
      // Best-effort — one missed reminder isn't worth crashing the whole
      // per-minute cron run over.
    }
  }
}

/**
 * Web Push protocol, implemented directly against WebCrypto (RFC 8291
 * payload encryption + RFC 8292 VAPID). No npm dependency — this repo has
 * no build step, so worker.js has to be able to run exactly as committed.
 */
function base64UrlToBytes(base64url) {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
function bytesToBase64Url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concatBytes(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

async function getVapidSigningKey(env) {
  // The public key's raw form (0x04 || x || y) already contains x and y —
  // no need to store them separately just to reconstruct the private JWK.
  const pubRaw = base64UrlToBytes(VAPID_PUBLIC_KEY);
  const x = pubRaw.slice(1, 33);
  const y = pubRaw.slice(33, 65);
  const d = base64UrlToBytes(env.VAPID_PRIVATE_KEY);
  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    x: bytesToBase64Url(x), y: bytesToBase64Url(y), d: bytesToBase64Url(d),
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// RFC 8292: a short-lived JWT proving this server is allowed to send to
// this push service, signed with the VAPID private key.
async function buildVapidHeader(endpoint, env) {
  const audience = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const claims = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:founder@allwaycreatives.com" };
  const enc = (obj) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = `${enc(header)}.${enc(claims)}`;
  const key = await getVapidSigningKey(env);
  // WebCrypto's ECDSA signature for P-256 is already the raw r||s (64
  // bytes) format JWS/ES256 expects — no DER-to-raw conversion needed.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${bytesToBase64Url(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`;
}

// RFC 8291: encrypts the notification payload so only the subscriber's
// browser (holder of the private half of p256dh) can read it — the push
// service itself never sees the plaintext.
async function encryptPushPayload(payloadStr, p256dhB64, authB64) {
  const payload = new TextEncoder().encode(payloadStr);
  const uaPublicRaw = base64UrlToBytes(p256dhB64);
  const authSecret = base64UrlToBytes(authB64);

  const uaPublicKey = await crypto.subtle.importKey("raw", uaPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const localKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", localKeyPair.publicKey));

  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, localKeyPair.privateKey, 256));

  // Stage 1: combine the ECDH secret with the subscription's auth secret.
  const ikmKeyMaterial = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  const keyInfo = concatBytes([new TextEncoder().encode("WebPush: info\0"), uaPublicRaw, localPublicRaw]);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: authSecret, info: keyInfo }, ikmKeyMaterial, 256
  ));

  // Stage 2: fresh random salt per message derives the actual content
  // encryption key and nonce from the stage-1 material.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cekBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("Content-Encoding: aes128gcm\0") }, ikmKey, 128
  );
  const nonceBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("Content-Encoding: nonce\0") }, ikmKey, 96
  );
  const cek = await crypto.subtle.importKey("raw", cekBits, "AES-GCM", false, ["encrypt"]);

  // Plaintext gets a single 0x02 delimiter byte appended (the "last
  // record" marker aes128gcm requires) — no extra padding beyond that.
  const plaintext = concatBytes([payload, new Uint8Array([2])]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(nonceBits) }, cek, plaintext));

  // aes128gcm record header: salt(16) + record size(4, big-endian) + key id length(1) + key id(65)
  const recordSize = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = 65;
  header.set(localPublicRaw, 21);

  return concatBytes([header, ciphertext]);
}

async function sendWebPush(subscription, payloadObj, env) {
  const { endpoint, keys } = subscription;
  const body = await encryptPushPayload(JSON.stringify(payloadObj), keys.p256dh, keys.auth);
  const vapidHeader = await buildVapidHeader(endpoint, env);
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
      "Authorization": vapidHeader,
    },
    body,
  });
}

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

  const mode = body.mode === "meeting" ? "meeting" : "idea";
  const businesses = Array.isArray(body.businesses) ? body.businesses : [];
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const contacts = Array.isArray(body.contacts) ? body.contacts : [];
  const vocabulary = Array.isArray(body.vocabulary) ? body.vocabulary.filter(Boolean) : [];
  const vocabLine = vocabulary.length ? ` The speaker runs a business and uses these proper nouns often — if something sounds close to one of these, prefer it over a generic word: ${vocabulary.join(", ")}.` : "";

  let instruction;
  if (mode === "meeting") {
    // Structured call/meeting recap: the founder talks through what just
    // happened on a call (WhatsApp, phone, whatever) right after hanging
    // up, and this turns that into something actually useful to file away
    // — not just a transcript, an actual brief.
    const catalog = [
      ...businesses.map(b => `business:${b.id} — ${b.name}`),
      ...contacts.map(c => `contact:${c.id} — ${c.name}`),
    ].join("\n");
    instruction = `Transcribe the attached voice memo exactly, word for word — the ENTIRE recording, however long. Do not summarize, shorten, or cut off the transcript itself; put the complete verbatim transcript in the "transcript" field and save shortening for the separate "summary"/"highlights" fields below.${vocabLine} This is a founder's spoken recap of a call/meeting they just finished — extract a structured brief from it.

Using ONLY this list of the founder's businesses and contacts, decide whether the recap clearly names one of them:
${catalog || "(none defined yet — always respond with matchType none)"}

Respond with ONLY this JSON object, no markdown fencing, no commentary:
{"transcript": "...", "summary": "one sentence on what the call was about", "highlights": ["key point 1", "key point 2"], "actionItems": ["thing to do 1", "thing to do 2"], "honestNotes": "the founder's candid read on how it went / how they feel about it, if they said anything like that — empty string if they didn't", "matchType": "business" | "none", "matchId": "the id after the colon above, or null", "contactMatchId": "a contact id from the list above if a specific person was named, or null", "confidence": 0.0 to 1.0}

highlights and actionItems should be short bullet-style phrases pulled from what was actually said — don't invent anything not implied by the recap. Empty arrays are fine if there's genuinely nothing to list. Only set matchType/contactMatchId if clearly named; use "none"/null and confidence 0 if there's any real doubt.`;
  } else {
    // Idea capture + business/project classification (original behavior).
    const catalog = [
      ...businesses.map(b => `business:${b.id} — ${b.name}`),
      ...projects.map(p => `project:${p.id} — ${p.name}`),
    ].join("\n");
    instruction = `Transcribe the attached voice memo exactly, word for word — the ENTIRE recording, however long it is. Do not summarize, shorten, paraphrase, or cut off the transcript itself, no matter how long the memo runs; put the complete verbatim transcript in the "transcript" field and save any shortening for the separate "summary" field below.${vocabLine}

Then, using ONLY this list of the founder's businesses and projects, decide whether the memo clearly belongs to one of them:
${catalog || "(none defined yet — always respond with matchType none)"}

Also produce a one-line summary of what the idea actually is, and a short, punchy, actionable title suitable for a task-tracking "Mission" the founder would create when they're ready to act on this idea (imperative, concrete — e.g. "Pitch the loyalty-app concept to two clients", not "Loyalty app idea").

Respond with ONLY this JSON object, no markdown fencing, no commentary:
{"transcript": "the complete, unabridged, word-for-word transcript", "summary": "one line on what this idea is", "suggestedMissionTitle": "a short actionable mission title", "matchType": "business" | "project" | "none", "matchId": "the id portion after the colon above, or null", "confidence": 0.0 to 1.0}

Only choose a match if the memo clearly names or strongly, unambiguously implies that specific business or project. If there's any real doubt, use "none" and confidence 0.`;
  }

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
          generationConfig: { maxOutputTokens: mode === "meeting" ? 4000 : 3000, responseMimeType: "application/json" },
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
    // hard guarantee — and a genuinely long recording could still get cut
    // off mid-response even with a generous token budget). Rather than
    // surfacing broken JSON syntax as the "transcript", pull just the
    // transcript field's text back out with a regex — this handles both a
    // fully malformed response and a response truncated mid-transcript
    // (the closing quote just won't be there, so we take what's there).
    const match = raw.match(/"transcript"\s*:\s*"((?:[^"\\]|\\.)*)"?/);
    const salvaged = match ? match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n") : raw.trim();
    parsed = { transcript: salvaged };
  }

  if (mode === "meeting") {
    return json({
      transcript: parsed.transcript || "",
      summary: parsed.summary || "",
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.filter(Boolean) : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.filter(Boolean) : [],
      honestNotes: parsed.honestNotes || "",
      matchType: parsed.matchType === "business" ? "business" : "none",
      matchId: parsed.matchId || null,
      contactMatchId: parsed.contactMatchId || null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    }, 200);
  }
  return json({
    transcript: parsed.transcript || "",
    summary: parsed.summary || "",
    suggestedMissionTitle: parsed.suggestedMissionTitle || "",
    matchType: parsed.matchType === "business" || parsed.matchType === "project" ? parsed.matchType : "none",
    matchId: parsed.matchId || null,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
  }, 200);
}

/**
 * Text-only sibling of handleVoiceCapture's "idea" mode — for ideas typed
 * manually (quick-capture modal, or edited after the fact) rather than
 * spoken. Same classification + summary + mission-title generation, minus
 * the audio transcription step since there's no audio to transcribe.
 */
async function handleIdeaAnalyze(request, env) {
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
  const text = (body.text || "").trim();
  if (!text) return json({ error: "text is required" }, 400);

  const businesses = Array.isArray(body.businesses) ? body.businesses : [];
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const catalog = [
    ...businesses.map(b => `business:${b.id} — ${b.name}`),
    ...projects.map(p => `project:${p.id} — ${p.name}`),
  ].join("\n");

  const instruction = `Here is an idea a founder jotted down: "${text}"

Using ONLY this list of the founder's businesses and projects, decide whether the idea clearly belongs to one of them:
${catalog || "(none defined yet — always respond with matchType none)"}

Also produce a one-line summary of what the idea actually is, and a short, punchy, actionable title suitable for a task-tracking "Mission" the founder would create when they're ready to act on this idea (imperative, concrete — e.g. "Pitch the loyalty-app concept to two clients", not "Loyalty app idea").

Respond with ONLY this JSON object, no markdown fencing, no commentary:
{"summary": "one line on what this idea is", "suggestedMissionTitle": "a short actionable mission title", "matchType": "business" | "project" | "none", "matchId": "the id portion after the colon above, or null", "confidence": 0.0 to 1.0}

Only choose a match if the idea clearly names or strongly, unambiguously implies that specific business or project. If there's any real doubt, use "none" and confidence 0.`;

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
          contents: [{ role: "user", parts: [{ text: instruction }] }],
          generationConfig: { maxOutputTokens: 500, responseMimeType: "application/json" },
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
    parsed = {};
  }

  return json({
    summary: parsed.summary || "",
    suggestedMissionTitle: parsed.suggestedMissionTitle || "",
    matchType: parsed.matchType === "business" || parsed.matchType === "project" ? parsed.matchType : "none",
    matchId: parsed.matchId || null,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
  }, 200);
}

/**
 * Anthropic sub-handler for the provider-agnostic assistant above. Same
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
