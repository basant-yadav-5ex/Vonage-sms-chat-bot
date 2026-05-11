/**
 * Find an owned number row via GET https://rest.nexmo.com/account/numbers
 * (pattern search first, then offset pagination using response `count`).
 */
import axios from "axios";

export function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

/** Same E.164 digit key as `server.js` normalizeNumber (10-digit US → prefix 1). */
export function normalizeMsisdnKey(input) {
  const digits = digitsOnly(input);
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

/** Inbound MO URL as returned by GET account/numbers (field names vary). */
export function pickMoHttpUrl(row) {
  if (!row || typeof row !== "object") return "";
  return (
    row.moHttpUrl ??
    row.mo_http_url ??
    row.moHttpURL ??
    ""
  ).trim();
}

/**
 * DLR / delivery-receipt URL if present on the row.
 * Vonage often omits per-number DLR from GET account/numbers even after number/update;
 * account-level `drCallBackUrl` may apply instead.
 */
export function pickDrCallBackUrl(row) {
  if (!row || typeof row !== "object") return "";
  return (
    row.drCallBackUrl ??
    row.dr_call_back_url ??
    row.moDrHttpUrl ??
    row.mo_dr_http_url ??
    row.drHttpUrl ??
    row.dr_http_url ??
    ""
  ).trim();
}

async function getOwnedPage(params) {
  const { data } = await axios.get("https://rest.nexmo.com/account/numbers", {
    params: {
      api_key: params.apiKey,
      api_secret: params.apiSecret,
      size: params.size ?? 100,
      index: params.index ?? 0,
      ...(params.country ? { country: params.country } : {}),
      ...(params.pattern ? { pattern: params.pattern, search_pattern: params.search_pattern ?? 1 } : {})
    },
    validateStatus: () => true
  });

  if (data?.["error-code"] && String(data["error-code"]) !== "200") {
    throw new Error(`account/numbers: ${JSON.stringify(data)}`);
  }

  const list = Array.isArray(data?.numbers) ? data.numbers : [];
  const countRaw = data?.count;
  const total = countRaw == null || countRaw === "" ? NaN : Number(countRaw);
  return { list, total };
}

function pickRow(list, wantKey) {
  return list.find((n) => normalizeMsisdnKey(n.msisdn) === wantKey) ?? null;
}

/**
 * @param {string} apiKey
 * @param {string} apiSecret
 * @param {string} wantDigits digits from .env (any common US formatting)
 * @returns {Promise<{ row: object, count?: number } | null>}
 */
export async function findOwnedNumberRow(apiKey, apiSecret, wantDigits) {
  const wantKey = normalizeMsisdnKey(wantDigits);
  const ten = wantKey.startsWith("1") && wantKey.length === 11 ? wantKey.slice(1) : wantKey;

  /* Pattern search: faster on large accounts; search_pattern 1 = contains (Nexmo). */
  const patterns = [...new Set([wantKey, ten, ten.slice(-7)].filter((p) => p && p.length >= 4))];
  for (const pattern of patterns) {
    for (const country of ["US", undefined]) {
      try {
        const { list } = await getOwnedPage({
          apiKey,
          apiSecret,
          size: 100,
          index: 0,
          pattern,
          search_pattern: 1,
          country
        });
        const row = pickRow(list, wantKey);
        if (row) return { row };
      } catch {
        /* ignore pattern errors; fall through to full list */
      }
    }
  }

  const size = 100;
  let scanned = 0;
  let reportedTotal = NaN;

  for (let index = 0; index < 10_000_000; index += size) {
    const { list, total } = await getOwnedPage({ apiKey, apiSecret, size, index });
    if (Number.isFinite(total)) reportedTotal = total;

    const row = pickRow(list, wantKey);
    if (row) return { row, count: Number.isFinite(reportedTotal) ? reportedTotal : undefined };

    scanned += list.length;
    if (list.length === 0) break;
    if (list.length < size) break;
    if (Number.isFinite(reportedTotal) && scanned >= reportedTotal) break;
  }

  return null;
}
