import axios from "axios";

export async function sendSms({ to, text }) {
  const url = "https://rest.nexmo.com/sms/json";

  const payload = {
    api_key: process.env.VONAGE_API_KEY,
    api_secret: process.env.VONAGE_API_SECRET,
    from: process.env.VONAGE_FROM,
    to,
    text
  };

  const res = await axios.post(url, payload, {
    timeout: 30000
  });

  return res.data;
}
