import express from "express";
import Stripe from "stripe";
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

// ⚡️ Fix des "\n" dans la clé privée Firebase
const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

// 🔥 Initialisation Firebase Admin
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

const app = express();

// -----------------------------
// Map PriceID → Role
// -----------------------------
const PLAN = {
  // TEST
  "price_1Rt7ErFD9N3apMZl5ZJra4sW": "community", // 10€
  "price_1Rt7ILFD9N3apMZlt1kpm4Lx": "biz",       // 35€
  "price_1RtmDdFD9N3apMZlul64n316": "community", // autre test
  "price_1RtmDpFD9N3apMZl6QpQyaQt": "biz",       // autre test

  // LIVE (à compléter avec tes vrais IDs)
  "price_live_xxx": "community", 
  "price_live_yyy": "biz",
};

// Fallback montant (en centimes)
const PLAN_BY_AMOUNT = {
  1000: "community", // 10 €
  3500: "biz",       // 35 €
};

// -----------------------------
// Webhook Stripe
// -----------------------------
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("⚠️ Webhook error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // 👉 On gère uniquement les paiements réussis
    if (event.type === "checkout.session.completed" || event.type === "invoice.paid") {
      const session = event.data.object;

      const customerEmail =
        session?.customer_details?.email || session?.customer_email;

      // On récupère l’abonnement via PriceID
      const lineItems = session.display_items || session.line_items || [];
      let priceId = null;

      if (lineItems?.[0]?.price?.id) {
        priceId = lineItems[0].price.id;
      } else if (session?.subscription) {
        try {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          priceId = subscription.items.data[0].price.id;
        } catch (err) {
          console.error("❌ Impossible de récupérer la subscription:", err);
        }
      }

      // Fallback via montant
      const amountCents =
        session.amount_total ||
        session.total ||
        session.amount_paid ||
        session.amount_due ||
        null;

      // Détermination du rôle
      let role = "member"; // valeur par défaut
      if (priceId && PLAN[priceId]) {
        role = PLAN[priceId];
      } else if (amountCents && PLAN_BY_AMOUNT[amountCents]) {
        role = PLAN_BY_AMOUNT[amountCents];
      }

      try {
        if (!customerEmail) {
          console.log("❌ Email introuvable dans la session Stripe");
        } else {
          const snapshot = await db
            .collection("users")
            .where("email", "==", customerEmail)
            .get();

          if (!snapshot.empty) {
            const userDoc = snapshot.docs[0];
            await userDoc.ref.update({ role });
            console.log(`✅ Rôle '${role}' mis à jour pour ${customerEmail}`);
          } else {
            console.log(`❌ Utilisateur non trouvé : ${customerEmail}`);
          }
        }
      } catch (err) {
        console.error("🔥 Erreur Firestore:", err);
      }
    }

    res.json({ received: true });
  }
);

// 👉 Export pour Vercel
export default app;
