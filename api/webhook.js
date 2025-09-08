import Stripe from "stripe";
import admin from "firebase-admin";
import fetch from "node-fetch";

// -----------------------------
// 🔥 Init Firebase Admin
// -----------------------------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}
const db = admin.firestore();

// -----------------------------
// ⚡ Stripe (live + test)
// -----------------------------
const stripeLive = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});
const stripeTest = process.env.STRIPE_SECRET_KEY_TEST
  ? new Stripe(process.env.STRIPE_SECRET_KEY_TEST, { apiVersion: "2023-10-16" })
  : null;

// -----------------------------
// 🔐 Webhook secrets
// -----------------------------
const webhookSecrets = [
  process.env.STRIPE_WEBHOOK_SECRET,
  process.env.STRIPE_WEBHOOK_SECRET_TEST,
].filter(Boolean);

// -----------------------------
// Plans Stripe → rôles Firestore
// -----------------------------
const PLAN = {
  "price_1Rt7ErFD9N3apMZl5ZJra4sW": "community",
  "price_1Rt7ILFD9N3apMZlt1kpm4Lx": "biz",
  "price_1RtmDdFD9N3apMZlul64n316": "community",
  "price_1RtmDpFD9N3apMZl6QpQyaQt": "biz",
};
const PLAN_BY_AMOUNT = { 1000: "community", 3500: "biz" };

// -----------------------------
// Lemlist API
// -----------------------------
const LEMLIST_API_KEY = process.env.LEMLIST_API_KEY;
const LEMLIST_API_URL = "https://api.lemlist.com/api";
const lemlistHeaders = {
  "Api-Key": LEMLIST_API_KEY,  // 👈 clé attendue
  "Accept": "application/json",
  "Content-Type": "application/json",
};

// GET lead by email
async function getLemlistLead(email) {
  const url = `${LEMLIST_API_URL}/leads?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: lemlistHeaders });
  if (res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Erreur Lemlist GET: ${res.status} ${res.statusText}${txt ? " – " + txt : ""}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data[0] || null : data || null;
}

// CREATE lead
async function createLemlistLead({ email, firstName = "", lastName = "", company = "Moovers" }) {
  const res = await fetch(`${LEMLIST_API_URL}/leads`, {
    method: "POST",
    headers: lemlistHeaders,
    body: JSON.stringify({ email, firstName, lastName, company }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Lemlist create lead non-ok (${res.status}): ${txt || res.statusText}`);
  }
  return res.json();
}

// Add lead to campaign
async function addLeadToCampaign(campaignId, email) {
  // endpoint documenté : POST /campaigns/{id}/leads/{email}?deduplicate=true
  const url = `${LEMLIST_API_URL}/campaigns/${campaignId}/leads/${encodeURIComponent(email)}?deduplicate=true`;
  const res = await fetch(url, { method: "POST", headers: lemlistHeaders });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Erreur Lemlist Campaign: ${res.status} ${res.statusText}${txt ? " – " + txt : ""}`);
  }
  return res.json();
}

// -----------------------------
// Config API (Vercel)
// -----------------------------
export const config = { api: { bodyParser: false } };

// -----------------------------
// Raw body helper
// -----------------------------
const getRawBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

// -----------------------------
// Webhook Stripe
// -----------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).send("No signature header");

  let event, body;
  try {
    body = await getRawBody(req);

    let ok = false;
    for (const secret of webhookSecrets) {
      try {
        event = stripeLive.webhooks.constructEvent(body, sig, secret);
        ok = true;
        break;
      } catch {
        // try next secret
      }
    }
    if (!ok) throw new Error("Webhook secret invalide");
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Choix client Stripe selon livemode
  let stripeClient = stripeLive;
  if (event.livemode === false && stripeTest) stripeClient = stripeTest;

  // ---------------------------
  // Paiements réussis
  // ---------------------------
  if (event.type === "checkout.session.completed" || event.type === "invoice.paid") {
    const session = event.data.object;
    const customerEmail = session?.customer_details?.email || session?.customer_email;
    if (!customerEmail) return res.status(200).json({ received: true, warning: "No email found" });

    // Récup PriceID
    let priceId = null;
    try {
      if (session.mode === "subscription" || session.subscription) {
        const subscription = await stripeClient.subscriptions.retrieve(session.subscription);
        priceId = subscription.items.data[0]?.price?.id || null;
      } else {
        const lineItems = await stripeClient.checkout.sessions.listLineItems(session.id, { limit: 1 });
        priceId = lineItems.data[0]?.price?.id || null;
      }
    } catch (err) {
      console.error("❌ Erreur récupération priceId:", err.message);
    }

    const amountCents = session.amount_total || session.total || 0;

    // Déterminer le rôle
    let role = "member";
    if (priceId && PLAN[priceId]) role = PLAN[priceId];
    else if (amountCents && PLAN_BY_AMOUNT[amountCents]) role = PLAN_BY_AMOUNT[amountCents];

    try {
      const snapshot = await db.collection("users").where("email", "==", customerEmail).get();
      if (!snapshot.empty) {
        const userDoc = snapshot.docs[0];
        const userId = userDoc.id;

        // ✅ Update Firestore
        await userDoc.ref.update({
          role,
          lastPayment: admin.firestore.FieldValue.serverTimestamp(),
          stripeCustomerId: session.customer,
          subscriptionId: session.subscription || null,
        });

        // 🚀 Lemlist (robuste)
        try {
          const fullName = session.customer_details?.name || "";
          const [firstName = "", lastName = ""] = fullName.split(" ");
          let lead = await getLemlistLead(customerEmail);
          if (!lead) {
            await createLemlistLead({ email: customerEmail, firstName, lastName });
          }

          const campaignIds = {
            community: process.env.LEMLIST_CAMPAIGN_COMMUNITY,
            biz: process.env.LEMLIST_CAMPAIGN_BIZ,
          };
          if (campaignIds[role]) {
            await addLeadToCampaign(campaignIds[role], customerEmail);
            console.log(`✅ Lemlist: ${customerEmail} → ${role}`);
          }
        } catch (err) {
          console.error("🔥 Erreur Lemlist:", err.message);
        }

        // -----------------------------
        // Parrainage (inchangé)
        // -----------------------------
        const fromCustomField = Array.isArray(session.custom_fields)
          ? (session.custom_fields.find(
              (f) =>
                (f.key?.toLowerCase?.() || "").includes("parrain") ||
                (f.label?.custom?.toLowerCase?.() || "").includes("parrain")
            )?.text?.value || null)
          : null;

        const referralCodeUsed = session.metadata?.referralCode || fromCustomField || null;

        if (referralCodeUsed) {
          const refSnap = await db.collection("users").where("referralCode", "==", referralCodeUsed).get();
          if (!refSnap.empty) {
            const parrainDoc = refSnap.docs[0];
            const parrainData = parrainDoc.data();

            const newCount = (parrainData.referralsCount || 0) + 1;
            let freeMonths = parrainData.freeMonths || 0;
            let monthGranted = false;
            if (newCount % 2 === 0) {
              freeMonths += 1;
              monthGranted = true;
            }

            await parrainDoc.ref.update({
              referralsCount: newCount,
              freeMonths,
              lastReferral: admin.firestore.FieldValue.serverTimestamp(),
              filleuls: admin.firestore.FieldValue.arrayUnion({
                uid: userId,
                email: customerEmail,
                subscribedAt: new Date().toISOString(),
              }),
            });

            await userDoc.ref.update({
              referredBy: parrainDoc.id,
              referralCodeUsed,
            });

            // 🎁 Mois offert Stripe si besoin
            if (monthGranted && parrainData.subscriptionId) {
              try {
                let coupon = null;
                const coupons = await stripeClient.coupons.list({ limit: 100 });
                coupon = coupons.data.find((c) => c.name === "1 mois offert");
                if (!coupon) {
                  coupon = await stripeClient.coupons.create({
                    percent_off: 100,
                    duration: "once",
                    name: "1 mois offert",
                  });
                }
                const sub = await stripeClient.subscriptions.retrieve(parrainData.subscriptionId);
                if (!sub.discount) {
                  await stripeClient.subscriptions.update(parrainData.subscriptionId, { coupon: coupon.id });
                  console.log(`🎉 Mois offert appliqué à ${parrainData.email}`);
                } else {
                  console.log(`ℹ️ ${parrainData.email} a déjà un coupon actif.`);
                }
              } catch (err) {
                console.error("🔥 Erreur application mois offert:", err.message);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("🔥 Erreur Firestore:", err);
      return res.status(500).json({ error: "Database error", received: true });
    }
  }

  res.status(200).json({ received: true, eventType: event.type });
}
