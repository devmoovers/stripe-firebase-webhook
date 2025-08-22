import Stripe from "stripe";
import admin from "firebase-admin";

// ✅ Fix des sauts de ligne de la clé privée Firebase
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

// 🔥 Initialisation Firebase Admin (évite les doublons en hot reload)
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

// -----------------------------
// Map PriceID → Role
// -----------------------------
const PLAN = {
  "price_1Rt7ErFD9N3apMZl5ZJra4sW": "community",
  "price_1Rt7ILFD9N3apMZlt1kpm4Lx": "biz",
  "price_1RtmDdFD9N3apMZlul64n316": "community",
  "price_1RtmDpFD9N3apMZl6QpQyaQt": "biz",

  // LIVE → mets tes vrais IDs Stripe
  "price_live_xxx": "community",
  "price_live_yyy": "biz",
};

// Fallback par montant (au cas où)
const PLAN_BY_AMOUNT = {
  1000: "community", // 10€
  3500: "biz",       // 35€
};

// -----------------------------
// Config Vercel
// -----------------------------
export const config = {
  api: {
    bodyParser: false, // ⚠️ Stripe veut le raw body
  },
};

// -----------------------------
// Webhook Stripe
// -----------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    // ⚡ Construire l’event Stripe depuis le raw body
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("⚠️ Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ---------------------------
  // Gestion des paiements réussis
  // ---------------------------
  if (event.type === "checkout.session.completed" || event.type === "invoice.paid") {
    const session = event.data.object;

    // ✅ Récup email
    const customerEmail =
      session?.customer_details?.email || session?.customer_email;

    let priceId = null;

    // 🔎 1. On essaie de récupérer le PriceID directement
    try {
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
      priceId = lineItems.data[0]?.price?.id || null;
    } catch (err) {
      console.error("❌ Impossible de récupérer les line_items:", err);
    }

    // 🔎 2. Sinon on tente via l’abonnement
    if (!priceId && session?.subscription) {
      try {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        priceId = subscription.items.data[0]?.price.id || null;
      } catch (err) {
        console.error("❌ Impossible de récupérer la subscription:", err);
      }
    }

    // 🔎 3. Fallback par montant payé
    const amountCents =
      session.amount_total ||
      session.total ||
      session.amount_paid ||
      session.amount_due ||
      null;

    // 🎯 Détermination du rôle
    let role = "member"; // défaut
    if (priceId && PLAN[priceId]) {
      role = PLAN[priceId];
    } else if (amountCents && PLAN_BY_AMOUNT[amountCents]) {
      role = PLAN_BY_AMOUNT[amountCents];
    }

    console.log(`📦 Event reçu: ${event.type} | email=${customerEmail} | priceId=${priceId} | role=${role}`);

    // ✅ Mise à jour Firestore
    if (customerEmail) {
      try {
        const snapshot = await db.collection("users").where("email", "==", customerEmail).get();

        if (!snapshot.empty) {
          const userDoc = snapshot.docs[0];
          await userDoc.ref.update({ role });
          console.log(`✅ Firestore: rôle '${role}' mis à jour pour ${customerEmail}`);
        } else {
          console.warn(`❌ Firestore: utilisateur non trouvé (${customerEmail})`);
        }
      } catch (err) {
        console.error("🔥 Erreur Firestore:", err);
      }
    }
  }

  // ⚡ Toujours répondre à Stripe
  res.status(200).json({ received: true });
}
