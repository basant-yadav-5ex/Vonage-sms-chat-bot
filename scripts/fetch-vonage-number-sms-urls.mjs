/**
 * Read SMS webhook URLs Vonage actually has on file for your number (Numbers API).
 * Use when the Dashboard looks correct but SMS Lifecycle shows "Unknown webhook domain"
 * on webhook forwarding — compare this output to your live ngrok BASE_URL.
 *
 * Paginates account/numbers (100 per page) so large accounts still find the LVN.
 */
import dotenv from "dotenv";
import {
  digitsOnly,
  findOwnedNumberRow,
  normalizeMsisdnKey,
  pickMoHttpUrl,
  pickDrCallBackUrl
} from "./lib/vonage-account-numbers.mjs";

dotenv.config({ quiet: true });

function envTrim(s) {
  return (s == null ? "" : String(s)).trim();
}

const apiKey = envTrim(process.env.VONAGE_API_KEY);
const apiSecret = envTrim(process.env.VONAGE_API_SECRET);
const fromRaw =
  envTrim(process.env.VONAGE_FROM) || envTrim(process.env.VONAGE_VIRTUAL_NUMBER);
const want = digitsOnly(fromRaw);
const wantKey = normalizeMsisdnKey(fromRaw);

if (!apiKey || !apiSecret) {
  console.error("Set VONAGE_API_KEY and VONAGE_API_SECRET in .env");
  process.exit(1);
}
if (!want) {
  console.error("Set VONAGE_FROM or VONAGE_VIRTUAL_NUMBER in .env");
  process.exit(1);
}

try {
  const found = await findOwnedNumberRow(apiKey, apiSecret, want);

  if (!found) {
    console.error(
      "No owned number matches",
      wantKey,
      "(from .env:",
      fromRaw,
      "; pattern search + paginated account/numbers)."
    );
    console.error(
      "Confirm in Vonage Dashboard → this API key (primary vs sub-account) actually owns that MSISDN."
    );
    console.error(
      "If `npm run sync:vonage-webhooks` still returns error-code 200, the update can target a number outside this key’s owned list — align VONAGE_API_KEY / SECRET with the account that owns the toll-free."
    );
    process.exit(1);
  }

  const { row } = found;

  const mo = pickMoHttpUrl(row);
  const dr = pickDrCallBackUrl(row);

  console.log("Vonage Numbers API — stored SMS URLs for", row.msisdn, "(" + (row.country || "?") + ")");
  console.log("");
  console.log("  moHttpUrl (inbound MO):", mo || "(empty — inbound webhooks will not work)");
  console.log("  DLR / DR callback:     ", dr || "(empty — often omitted in this API list; see README)");
  console.log("");
  console.log("Compare `moHttpUrl` host to your current tunnel (e.g. BASE_URL in .env).");
  console.log("If they differ, run: npm run sync:vonage-webhooks");
  console.log("");

  const moEmpty = !String(mo || "").trim();
  if (moEmpty) {
    console.log("moHttpUrl is empty — Vonage will not forward inbound SMS to your app.");
    console.log("Fix:");
    console.log("  1) Start this repo (npm start) and ngrok so BASE_URL is live and returns HTTP 200.");
    console.log("  2) Vonage GET-validates the webhook URL before storing it; tunnel down = URL not saved.");
    console.log("  3) Run: npm run sync:vonage-webhooks");
    console.log("  4) Re-run: npm run vonage:show-sms-urls (moHttpUrl should then show your https URL).");
    console.log("");
  }

  console.log("Raw row (for support / debugging):");
  console.log(JSON.stringify(row, null, 2));
} catch (e) {
  console.error(e?.message || e);
  process.exit(1);
}
