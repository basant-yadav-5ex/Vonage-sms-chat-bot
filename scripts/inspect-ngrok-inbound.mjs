/**
 * Lists recent ngrok-captured HTTP requests whose path looks like Vonage webhooks.
 * Plan: confirm whether Vonage MO hits /api/vonage/inbound-sms when a phone sends SMS to your LVN
 * (curl from your PC proves your URL works; this shows what actually reached ngrok).
 *
 * Requires ngrok running (default local API http://127.0.0.1:4040).
 */
const webAddr = (process.env.NGROK_WEB_ADDR || "127.0.0.1:4040").replace(/^https?:\/\//, "");
const base = `http://${webAddr}`;

function pathFromReq(req) {
  if (!req || typeof req !== "object") return "";
  if (typeof req.uri === "string") return req.uri;
  const u = req.URL || req.url;
  if (typeof u === "string") return u;
  if (req.headers?.[":path"]) return req.headers[":path"];
  const line = req.Method && req.Path ? `${req.Method} ${req.Path}` : "";
  if (typeof line === "string" && line.includes("/")) return line.split(/\s+/).slice(1).join(" ") || line;
  return "";
}

function methodFromReq(req) {
  if (!req || typeof req !== "object") return "";
  if (typeof req.method === "string") return req.method;
  if (typeof req.Method === "string") return req.Method;
  const line = req.Method && req.Path ? `${req.Method} ${req.Path}` : "";
  const m = String(line).match(/^(\w+)/);
  return m ? m[1] : "";
}

function statusFromCapture(r) {
  const res = r?.response;
  if (!res || typeof res !== "object") return "";
  if (res.status) return String(res.status);
  if (res.Status) return String(res.Status);
  return "";
}

async function main() {
  const url = `${base}/api/requests/http?limit=100`;
  let j;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) {
      console.error(`ngrok API ${url} returned HTTP ${r.status}. Is ngrok running?`);
      process.exit(1);
    }
    j = await r.json();
  } catch (e) {
    console.error(
      `Cannot reach ngrok local API at ${base} (${e.message || e}).\n` +
        "Start ngrok (e.g. npm run tunnel) and try again."
    );
    process.exit(1);
  }

  let list = [];
  if (Array.isArray(j)) list = j;
  else if (Array.isArray(j?.requests)) list = j.requests;
  else if (Array.isArray(j?.Requests)) list = j.Requests;
  else if (Array.isArray(j?.http_requests)) list = j.http_requests;
  const needleInbound = "inbound-sms";
  const needleDlr = "/sms/status";

  const matches = list.filter((r) => {
    const req = r.request || r.Request;
    const p = pathFromReq(req);
    return p.includes(needleInbound) || p.includes(needleDlr);
  });

  console.log("");
  console.log(`ngrok web API: ${base}`);
  console.log(`Recent captures (last ${list.length}): ${matches.length} Vonage-like (inbound-sms or /sms/status)`);
  console.log("");

  if (matches.length === 0) {
    if (list.length === 0 && j && typeof j === "object" && !Array.isArray(j)) {
      console.log("(If this is unexpected, ngrok returned keys:", Object.keys(j).join(", ") + ".)");
    }
    console.log(
      "No /api/vonage/inbound-sms or /sms/status in recent ngrok memory.\n" +
        "Have someone send an SMS to your Vonage number while ngrok runs, then run this again.\n" +
        "If only /sms/status appears after you send from the test app, Vonage is not posting MO to inbound yet."
    );
    return;
  }

  for (const r of matches.slice(-30)) {
    const req = r.request || r.Request;
    const path = pathFromReq(req);
    const method = methodFromReq(req) || "?";
    const st = statusFromCapture(r);
    const start = r.start || r.Start || r.started_at || "";
    console.log(`${String(start).slice(0, 26).padEnd(27)} ${method.padEnd(6)} ${st.padEnd(4)} ${path}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
