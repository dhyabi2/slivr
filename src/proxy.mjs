// proxy.mjs — a tiny zero-dep INJECTING HTTP proxy, so a SERVED game gets the same harness verification as
// a static file. The harness verifies a static game by rewriting the html on disk + loading file://; a
// running Node app can't be rewritten, so we put a transparent proxy in front of it: every request is
// forwarded to the real server, and any text/html response gets the harness driver injected before Chrome
// sees it. Other paths (CSS/JS/assets) pass straight through, so relative URLs keep resolving. This is what
// lets autoplay / level-extract / canvas-capture run over http://, not just file://.

import http from "node:http";

// Start a proxy in front of targetBase (e.g. "http://localhost:3000"). injectHtml(html) → the html to serve
// for text/html responses (inject your driver there). Returns { url, close }. Zero deps (node http + fetch).
export async function startInjectProxy(targetBase, injectHtml) {
  const base = String(targetBase).replace(/\/+$/, "");
  const server = http.createServer(async (req, res) => {
    try {
      let body = null;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks = []; for await (const c of req) chunks.push(c); body = Buffer.concat(chunks);
      }
      const headers = { ...req.headers };
      delete headers.host; delete headers["accept-encoding"]; delete headers.connection;
      const r = await fetch(base + req.url, { method: req.method, headers, body, redirect: "manual" });
      const ct = r.headers.get("content-type") || "";
      const outHeaders = {};
      r.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) outHeaders[k] = v; });
      if (/text\/html/i.test(ct)) {
        const injected = injectHtml(await r.text());
        outHeaders["content-type"] = "text/html; charset=utf-8";
        res.writeHead(r.status, outHeaders);
        res.end(injected);
      } else {
        res.writeHead(r.status, outHeaders);
        res.end(Buffer.from(await r.arrayBuffer()));
      }
    } catch (e) {
      try { res.writeHead(502); res.end("proxy error: " + (e && e.message || e)); } catch { /* */ }
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
