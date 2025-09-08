import Stripe from "stripe";
import admin from "firebase-admin";
import fetch from "node-fetch";

const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

// 🔥 Init Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
}
const db = admin.firestore();

// ⚡ Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// 🔐 Webhook secrets (TEST + PROD)
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

// Fallback par montant (€ → role)
const PLAN_BY_AMOUNT = {
  1000: "community", // 10 €
  3500: "biz",       // 35 €
};

// -----------------------------
// Lemlist API helpers
// -----------------------------
const LEMLIST_API_KEY = process.env.LEMLIST_API_KEY;
const LEMLIST_API_URL = "https://api.lemlist.com/api";

// Vérifie si un contact existe
async function getLemlistContact(email) {
  const res = await fetch(`${LEMLIST_API_URL}/contacts/${email}`, {
    headers: {
      Authorization: `Bearer ${LEMLIST_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Erreur Lemlist GET: ${res.statusText}`);
  return await res.json();
}

// Crée un contact
async function createLemlistContact(email, firstName, lastName) {
  const res = await fetch(`${LEMLIST_API_URL}/contacts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LEMLIST_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, firstName, lastName }),
  });

  if (!res.ok) throw new Error(`Erreur Lemlist POST: ${res.statusText}`);
  return await res.json();
}

// Ajoute un contact à une campagne
async function addToCampaign(campaignId, email) {
  const res = await fetch(`${LEMLIST_API_URL}/campaigns/${campaignId}/leads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LEMLIST_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });

  if (!res.ok) throw new Error(`Erreur Lemlist Campaign: ${res.statusText}`);
  return await res.json();
}

// -----------------------------
// Config API (Vercel)
// -----------------------------
export const config = {
  api: {
    bodyParser: false,
  },
};

// -----------------------------
// Raw body helper
// -----------------------------
const getRawBody = (req) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
};

// -----------------------------
// Webhook Stripe
// -----------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).send("No signature header");
  }

  let event;
  let body;

  try {
    body = await getRawBody(req);

    let eventConstructed = false;
    for (const secret of webhookSecrets) {
      try {
        event = stripe.webhooks.constructEvent(body, sig, secret);
        eventConstructed = true;
        break;
      } catch {
        continue;
      }
    }

    if (!eventConstructed) throw new Error("Webhook secret invalide");
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ---------------------------
  // Paiements réussis
  // ---------------------------
  if (event.type === "checkout.session.completed" || event.type === "invoice.paid") {
    const session = event.data.object;

    const customerEmail =
      session?.customer_details?.email || session?.customer_email;
    if (!customerEmail) {
      return res.status(200).json({ received: true, warning: "No email found" });
    }

    // 🔎 Récup PriceID
    let priceId = null;
    try {
      if (session.mode === "subscription" || session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        priceId = subscription.items.data[0]?.price.id;
      } else {
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
        priceId = lineItems.data[0]?.price?.id;
      }
    } catch (err) {
      console.error("❌ Erreur récupération priceId:", err.message);
    }

    const amountCents = session.amount_total || session.total || 0;

    // 🎯 Détermination du rôle
    let role = "member";
    if (priceId && PLAN[priceId]) role = PLAN[priceId];
    else if (amountCents && PLAN_BY_AMOUNT[amountCents]) role = PLAN_BY_AMOUNT[amountCents];

    try {
      const snapshot = await db.collection("users").where("email", "==", customerEmail).get();

      if (!snapshot.empty) {
        const userDoc = snapshot.docs[0];
        const userId = userDoc.id;

        // ✅ Update Firestore de base
        await userDoc.ref.update({
          role,
          lastPayment: admin.firestore.FieldValue.serverTimestamp(),
          stripeCustomerId: session.customer,
          subscriptionId: session.subscription || null,
        });

        // -----------------------------
        // 🚀 Lemlist: ajout dans la campagne
        // -----------------------------
        try {
          const existing = await getLemlistContact(customerEmail);

          if (!existing) {
            await createLemlistContact(
              customerEmail,
              session.customer_details?.name?.split(" ")[0] || "",
              session.customer_details?.name?.split(" ")[1] || ""
            );
          }

          // Campagne par rôle
          const campaignIds = {
            community: process.env.LEMLIST_CAMPAIGN_COMMUNITY,
            biz: process.env.LEMLIST_CAMPAIGN_BIZ,
          };

          const targetCampaign = campaignIds[role] || campaignIds.member;
          if (targetCampaign) {
            await addToCampaign(targetCampaign, customerEmail);
            console.log(`✅ Ajout Lemlist: ${customerEmail} → ${role} (${targetCampaign})`);
          }
        } catch (err) {
          console.error("🔥 Erreur Lemlist:", err);
        }

        // -----------------------------
        // Gestion du parrainage
        // -----------------------------
        const referralCodeUsed =
          session.metadata?.referralCode ||
          session.custom_fields?.find(f => f.key === "Code parrainage (optionnel)")?.text?.value;

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

            let monthGranted = false;
            if (newCount % 2 === 0) {
              freeMonths += 1;
              monthGranted = true;
            }

            // ✅ Update parrain
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

            // ✅ Update filleul
            await userDoc.ref.update({
              referredBy: parrainDoc.id,
              referralCodeUsed,
            });

            // 🚀 Appliquer mois offert dans Stripe
            if (monthGranted && parrainData.subscriptionId) {
              try {
                let coupon = null;
                const coupons = await stripe.coupons.list({ limit: 100 });
                coupon = coupons.data.find((c) => c.name === "1 mois offert");

                if (!coupon) {
                  coupon = await stripe.coupons.create({
                    percent_off: 100,
                    duration: "once",
                    name: "1 mois offert",
                  });
                }

                const sub = await stripe.subscriptions.retrieve(parrainData.subscriptionId);
                if (!sub.discount) {
                  await stripe.subscriptions.update(parrainData.subscriptionId, {
                    coupon: coupon.id,
                  });
                  console.log(`🎉 Mois offert appliqué au parrain ${parrainData.email}`);
                } else {
                  console.log(`ℹ️ Parrain ${parrainData.email} a déjà un coupon actif.`);
                }
              } catch (err) {
                console.error("🔥 Erreur application mois offert:", err);
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
