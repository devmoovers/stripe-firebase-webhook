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
const webhookSecrets = [
  process.env.STRIPE_WEBHOOK_SECRET,
  process.env.STRIPE_WEBHOOK_SECRET_TEST,
].filter(Boolean);

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
   Lemlist (Basic Auth)
----------------------------- */
const LEMLIST_API_KEY = process.env.LEMLIST_API_KEY;
const LEMLIST_API_URL = "https://api.lemlist.com/api";

// username = API key, password vide
const lemlistAuthHeader = "Basic " + Buffer.from(`${LEMLIST_API_KEY}:`).toString("base64");

/** Ajoute un email à une campagne (et crée le lead si besoin) */
async function lemlistAddToCampaign(campaignId, email) {
  const url = `${LEMLIST_API_URL}/campaigns/${campaignId}/leads/${encodeURIComponent(
    email
  )}?deduplicate=true`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: lemlistAuthHeader, "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Lemlist campaign error: ${res.status} ${res.statusText} – ${txt}`);
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
   Helpers
----------------------------- */
function pickReferralFromCustomFields(session) {
  if (!Array.isArray(session?.custom_fields)) return null;
  const f = session.custom_fields.find(
    (x) =>
      (x.key && x.key.toLowerCase().includes("parrain")) ||
      (x.label && x.label.toLowerCase().includes("parrain"))
  );
  return f?.text?.value || null;
}

/* -----------------------------
   Webhook
----------------------------- */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).send("No signature header");

  // Construire l'event avec raw body + secrets
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
        // try next
      }
    }
    if (!ok) throw new Error("Webhook secret invalide");
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Choix du client Stripe (test/live)
  let stripeClient = stripeLive;
  if (event.livemode === false && stripeTest) stripeClient = stripeTest;

  /* -------------------------------------------------
     1) checkout.session.completed → onboarding + parrainage + Lemlist
  ------------------------------------------------- */
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const customerEmail = session?.customer_details?.email || session?.customer_email || null;
    if (!customerEmail) {
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

    // Déterminer le rôle
    let role = "member";
    if (priceId && PLAN[priceId]) role = PLAN[priceId];
    else if (PLAN_BY_AMOUNT[amountCents]) role = PLAN_BY_AMOUNT[amountCents];

    try {
      const snapshot = await db.collection("users").where("email", "==", customerEmail).get();
      if (snapshot.empty) {
        console.warn(`Firestore: utilisateur introuvable (${customerEmail})`);
      } else {
        const userDoc = snapshot.docs[0];
        const userId = userDoc.id;

        // MAJ de base
        await userDoc.ref.update({
          role,
          lastPayment: admin.firestore.FieldValue.serverTimestamp(),
          stripeCustomerId: session.customer || null,
          subscriptionId: session.subscription || null,
        });

        // Lemlist → ajouter en campagne par rôle (création implicite du lead)
        try {
          const campaigns = {
            community: process.env.LEMLIST_CAMPAIGN_COMMUNITY,
            biz: process.env.LEMLIST_CAMPAIGN_BIZ,
          };
          const targetCampaign = campaigns[role];
          if (targetCampaign) {
            await lemlistAddToCampaign(targetCampaign, customerEmail);
            console.log(`Lemlist: ${customerEmail} → ${role} (campagne ${targetCampaign})`);
          }
        } catch (e) {
          console.error("🔥 Lemlist error:", e.message);
        }

        // Parrainage (uniquement ici car custom_fields dispo sur checkout.session.completed)
        const referralCodeUsed =
          pickReferralFromCustomFields(session) || session?.metadata?.referralCode || null;

        if (referralCodeUsed) {
          const refSnap = await db
            .collection("users")
            .where("referralCode", "==", referralCodeUsed)
            .get();

          if (!refSnap.empty) {
            const parrainDoc = refSnap.docs[0];
            const parrainData = parrainDoc.data();

            const newCount = (parrainData.referralsCount || 0) + 1;
            let freeMonths = parrainData.freeMonths || 0;
            const monthGranted = newCount % 2 === 0;
            if (monthGranted) freeMonths += 1;

            // MAJ parrain
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

            // MAJ filleul
            await userDoc.ref.update({ referredBy: parrainDoc.id, referralCodeUsed });

            // Mois offert via coupon
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
      }
    } catch (err) {
      console.error("🔥 Erreur Firestore:", err);
      return res.status(500).json({ error: "Database error", received: true });
    }

    return res.status(200).json({ received: true, eventType: event.type });
  }

  /* -------------------------------------------------
     2) invoice.paid → renouvellement (pas de custom_fields ici)
  ------------------------------------------------- */
  if (event.type === "invoice.paid") {
    const invoice = event.data.object;

    try {
      // email depuis le customer
      const customerId = invoice.customer;
      let customerEmail = null;
      if (customerId) {
        const customer = await stripeClient.customers.retrieve(customerId);
        customerEmail = customer?.email || null;
      }

      if (!customerEmail) {
        return res.status(200).json({ received: true, warning: "No email on invoice" });
      }

      // déduction rôle via priceId ou montant de l'Invoice
      let role = "member";
      const priceId = invoice.lines?.data?.[0]?.price?.id || null;
      const amountCents = invoice.amount_paid || invoice.amount_due || 0;
      if (priceId && PLAN[priceId]) role = PLAN[priceId];
      else if (PLAN_BY_AMOUNT[amountCents]) role = PLAN_BY_AMOUNT[amountCents];

      const snapshot = await db.collection("users").where("email", "==", customerEmail).get();
      if (!snapshot.empty) {
        const userDoc = snapshot.docs[0];
        await userDoc.ref.update({
          role,
          lastPayment: admin.firestore.FieldValue.serverTimestamp(),
          stripeCustomerId: customerId || null,
          subscriptionId: invoice.subscription || null,
        });
      }

      // (On ne traite PAS le parrainage ici: pas de custom_fields à cette étape)
    } catch (e) {
      console.error("invoice.paid handling error:", e.message);
      return res.status(500).json({ error: "Invoice handling error", received: true });
    }

    return res.status(200).json({ received: true, eventType: event.type });
  }

  // autres events → ack
  return res.status(200).json({ received: true, eventType: event.type });
}
