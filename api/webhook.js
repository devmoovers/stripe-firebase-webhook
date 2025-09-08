import Stripe from "stripe";
import admin from "firebase-admin";
import fetch from "node-fetch";

/* -----------------------------
   🔥 Firebase Admin
----------------------------- */
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

/* -----------------------------
   ⚡ Stripe (live + test)
----------------------------- */
const stripeLive = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
const stripeTest = process.env.STRIPE_SECRET_KEY_TEST
  ? new Stripe(process.env.STRIPE_SECRET_KEY_TEST, { apiVersion: "2023-10-16" })
  : null;

/* -----------------------------
   🔐 Webhook secrets
----------------------------- */
const webhookSecrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_WEBHOOK_SECRET_TEST].filter(Boolean);

/* -----------------------------
   Plans Stripe → rôles Firestore
----------------------------- */
const PLAN = {
  "price_1Rt7ErFD9N3apMZl5ZJra4sW": "community",
  "price_1Rt7ILFD9N3apMZlt1kpm4Lx": "biz",
  "price_1RtmDdFD9N3apMZlul64n316": "community",
  "price_1RtmDpFD9N3apMZl6QpQyaQt": "biz",
};
const PLAN_BY_AMOUNT = { 1000: "community", 3500: "biz" };

/* -----------------------------
   Lemlist helpers (API v1)
----------------------------- */
const LEMLIST_API_KEY = process.env.LEMLIST_API_KEY;
const LEMLIST_API_URL = "https://api.lemlist.com/api";

const lemlistHeaders = {
  Authorization: `Bearer ${LEMLIST_API_KEY}`,
  "Content-Type": "application/json",
};

/** Création "douce" du lead */
async function ensureLemlistLead(email, firstName = "", lastName = "") {
  try {
    const res = await fetch(`${LEMLIST_API_URL}/leads`, {
      method: "POST",
      headers: lemlistHeaders,
      body: JSON.stringify({ email, firstName, lastName, company: "Moovers" }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`Lemlist create lead non-ok (${res.status}): ${txt}`);
    } else {
      console.log(`Lemlist lead créé: ${email}`);
    }
  } catch (e) {
    console.warn("Lemlist create lead – exception (ignorée):", e.message);
  }
}

/** Ajout dans la campagne */
async function addToCampaign(campaignId, email) {
  const url = `${LEMLIST_API_URL}/campaigns/${campaignId}/leads/${encodeURIComponent(
    email
  )}?deduplicate=true`;

  const res = await fetch(url, { method: "POST", headers: lemlistHeaders });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `Erreur Lemlist Campaign: ${res.status} ${res.statusText} – ${txt}`
    );
  }
  return res.json().catch(() => ({}));
}

/* -----------------------------
   Vercel config (raw body)
----------------------------- */
export const config = { api: { bodyParser: false } };

const getRawBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

/* -----------------------------
   Webhook handler
----------------------------- */
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

  // Choix Stripe client selon live/test
  let stripeClient = stripeLive;
  if (event.livemode === false && stripeTest) stripeClient = stripeTest;

  if (event.type === "checkout.session.completed" || event.type === "invoice.paid") {
    const session = event.data.object;

    // email client
    const customerEmail = session?.customer_details?.email || session?.customer_email || null;
    if (!customerEmail) {
      console.warn("Stripe webhook: pas d'email dans la session");
      return res.status(200).json({ received: true, warning: "No email found" });
    }

    // Récup du priceId
    let priceId = null;
    try {
      if (session.mode === "subscription" || session.subscription) {
        const sub = await stripeClient.subscriptions.retrieve(session.subscription);
        priceId = sub.items?.data?.[0]?.price?.id || null;
      } else {
        const items = await stripeClient.checkout.sessions.listLineItems(session.id, { limit: 1 });
        priceId = items.data?.[0]?.price?.id || null;
      }
    } catch (e) {
      console.error("Erreur récupération priceId:", e.message);
    }

    const amountCents = session.amount_total || session.total || 0;

    // Détermination du rôle
    let role = "member";
    if (priceId && PLAN[priceId]) role = PLAN[priceId];
    else if (PLAN_BY_AMOUNT[amountCents]) role = PLAN_BY_AMOUNT[amountCents];

    try {
      const snapshot = await db.collection("users").where("email", "==", customerEmail).get();
      if (!snapshot.empty) {
        const userDoc = snapshot.docs[0];
        const userId = userDoc.id;

        // Update Firestore
        await userDoc.ref.update({
          role,
          lastPayment: admin.firestore.FieldValue.serverTimestamp(),
          stripeCustomerId: session.customer || null,
          subscriptionId: session.subscription || null,
        });

        /* -----------------------------
           Lemlist
        ----------------------------- */
        try {
          const fullName = session?.customer_details?.name || "";
          const [firstName = "", lastName = ""] = fullName.split(" ");
          await ensureLemlistLead(customerEmail, firstName, lastName);

          const campaignIds = {
            community: process.env.LEMLIST_CAMPAIGN_COMMUNITY,
            biz: process.env.LEMLIST_CAMPAIGN_BIZ,
          };
          const target = campaignIds[role];
          if (target) {
            await addToCampaign(target, customerEmail);
            console.log(`Lemlist OK: ${customerEmail} → ${role} (campagne ${target})`);
          }
        } catch (err) {
          console.error("🔥 Erreur Lemlist:", err.message);
        }

        /* -----------------------------
           Parrainage
        ----------------------------- */
        const referralCodeUsed =
          (Array.isArray(session.custom_fields)
            ? session.custom_fields.find((f) =>
                (f.key || "").toLowerCase().includes("parrain")
              )?.text?.value
            : null) ||
          session?.metadata?.referralCode ||
          null;

        if (referralCodeUsed) {
          const refSnap = await db.collection("users").where("referralCode", "==", referralCodeUsed).get();
          if (!refSnap.empty) {
            const parrainDoc = refSnap.docs[0];
            const parrainData = parrainDoc.data();

            const newCount = (parrainData.referralsCount || 0) + 1;
            let freeMonths = parrainData.freeMonths || 0;
            const monthGranted = newCount % 2 === 0;
            if (monthGranted) freeMonths += 1;

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

            await userDoc.ref.update({ referredBy: parrainDoc.id, referralCodeUsed });

            // Mois offert (coupon) au parrain
            if (monthGranted && parrainData.subscriptionId) {
              try {
                const coupons = await stripeClient.coupons.list({ limit: 100 });
                let coupon = coupons.data.find((c) => c.name === "1 mois offert");
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
                  console.log(`ℹ️ ${parrainData.email} a déjà un coupon actif`);
                }
              } catch (e) {
                console.error("Erreur application mois offert:", e.message);
              }
            }
          }
        }
      } else {
        console.warn(`Utilisateur introuvable dans Firestore: ${customerEmail}`);
      }
    } catch (err) {
      console.error("Erreur Firestore:", err);
      return res.status(500).json({ error: "Database error", received: true });
    }
  }

  return res.status(200).json({ received: true, eventType: event.type });
}
