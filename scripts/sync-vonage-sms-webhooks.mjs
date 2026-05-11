/**
 * Pushes inbound + DLR webhook URLs to your Vonage virtual number via Numbers API.
 * Fixes "no hits on /api/vonage/inbound-sms" when the dashboard URL was never set or ngrok changed.
 *
 * Requires .env: VONAGE_API_KEY, VONAGE_API_SECRET, BASE_URL (https, no trailing slash),
 * and VONAGE_FROM or VONAGE_VIRTUAL_NUMBER (E.164 digits).
 *
 * If your number is linked to a Vonage API Application for Messages API, inbound may use
 * the application's Inbound URL instead — set that URL in the dashboard to the same path.
 */
import dotenv from "dotenv";
import axios from "axios";
import {
  findOwnedNumberRow,
  digitsOnly,
  pickMoHttpUrl,
  pickDrCallBackUrl
} from "./lib/vonage-account-numbers.mjs";

dotenv.config({ quiet: true });

function envTrim(s) {
  return (s == null ? "" : String(s)).trim();
}

function countryForE164(d) {
  if (d.startsWith("1") && (d.length === 11 || d.length === 10)) return "US";
  if (d.startsWith("44")) return "GB";
  return "";
}

const apiKey = envTrim(process.env.VONAGE_API_KEY);
const apiSecret = envTrim(process.env.VONAGE_API_SECRET);
const base = envTrim(process.env.BASE_URL).replace(/\/$/, "");
const fromRaw =
  envTrim(process.env.VONAGE_FROM) || envTrim(process.env.VONAGE_VIRTUAL_NUMBER);
const msisdn = digitsOnly(fromRaw);

if (!apiKey || !apiSecret) {
  console.error("Set VONAGE_API_KEY and VONAGE_API_SECRET in .env");
  process.exit(1);
}
if (!base.startsWith("https://")) {
  console.error("BASE_URL must be https (ngrok https URL), no trailing slash. Got:", base || "(empty)");
  process.exit(1);
}
if (!msisdn) {
  console.error("Set VONAGE_FROM or VONAGE_VIRTUAL_NUMBER in .env");
  process.exit(1);
}

const country = countryForE164(msisdn);
if (!country) {
  console.error(
    "Could not infer Vonage `country` from the number. Extend countryForE164() for your country or set country in this script."
  );
  process.exit(1);
}

const moHttpUrl = `${base}/api/vonage/inbound-sms`;
const drCallBackUrl = `${base}/sms/status`;

const body = new URLSearchParams({
  api_key: apiKey,
  api_secret: apiSecret,
  country,
  msisdn,
  moHttpUrl,
  drCallBackUrl
});

try {
  const { data } = await axios.post("https://rest.nexmo.com/number/update", body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    validateStatus: () => true
  });

  console.log("Vonage number/update response:", data);

  const code = String(data?.["error-code"] ?? data?.error_code ?? "");
  if (code && code !== "200") {
    console.error("Update did not succeed. If the number is linked to an API Application,");
    console.error("open that application in the dashboard and set Inbound URL to:");
    console.error(" ", moHttpUrl);
    process.exit(1);
  }

  console.log("");
  console.log("Configured on number", msisdn, "(" + country + "):");
  console.log("  Inbound (MO):", moHttpUrl);
  console.log("  DLR:         ", drCallBackUrl);
  console.log("");
  console.log(
    "Note: Vonage may GET your moHttpUrl before saving. If ngrok or the app is down, the URL can stay empty — keep server + tunnel running, then re-run this script."
  );
  console.log("");

  const found = await findOwnedNumberRow(apiKey, apiSecret, msisdn);
  if (!found) {
    console.warn(
      "Read-back: number",
      msisdn,
      "not found after paging account/numbers — wrong account or MSISDN not owned here. Run: npm run vonage:show-sms-urls"
    );
    console.log("");
  } else {
    const row = found.row;
    const storedMo = pickMoHttpUrl(row) || "(empty)";
    const storedDr = pickDrCallBackUrl(row) || "(empty — list endpoint often omits DLR; MO above is what fixes inbound)";
    console.log("Read-back from Vonage API for this number:");
    console.log("  moHttpUrl:", storedMo);
    console.log("  DLR:      ", storedDr);
    console.log("");
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
