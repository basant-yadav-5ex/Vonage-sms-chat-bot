import axios from "axios";

function envTrim(s) {
  return (s == null ? "" : String(s)).trim();
}

export async function sendSms({ to, text }) {
  const url = "https://rest.nexmo.com/sms/json";

  const from =
    envTrim(process.env.VONAGE_FROM) || envTrim(process.env.VONAGE_VIRTUAL_NUMBER);

  const payload = {
    api_key: envTrim(process.env.VONAGE_API_KEY),
    api_secret: envTrim(process.env.VONAGE_API_SECRET),
    from,
    to,
    text
  };

  const res = await axios.post(url, payload, {
    timeout: 30000
  });

  return res.data;
}
