// api/lemlist-add-lead.js
// Serverless function Vercel - ajoute un lead à une campagne Lemlist
const allowOrigin =
  process.env.NODE_ENV === "development" ? "*" : (process.env.CORS_ALLOW_ORIGIN || "*"); // mets ton domaine en prod

export const config = {
  api: {
    bodyParser: true, // on reçoit du JSON depuis l'app
  },
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { email, firstName = "", lastName = "" } = req.body || {};
    if (!email) return res.status(400).json({ error: "Missing email" });

    const key = process.env.LEMLIST_API_KEY;
    const campaignId = process.env.LEMLIST_CAMPAIGN_ID;
    if (!key || !campaignId) {
      return res.status(500).json({ error: "Missing Lemlist env vars" });
    }

    const auth = Buffer.from(`:${key}`).toString("base64");
    const url = `https://api.lemlist.com/api/campaigns/${campaignId}/leads/${encodeURIComponent(
      email
    )}?deduplicate=true`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ firstName, lastName, companyName: "" }),
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(r.status).send(text || "Lemlist error");
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("lemlist-add-lead error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
