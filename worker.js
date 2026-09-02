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

    // Anything else: behave exactly like the old assets-only deployment.
    return env.ASSETS.fetch(request);
  },
};

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
