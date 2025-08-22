import express from "express";
import Stripe from "stripe";
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

// ⚡️ Fix des "\n" dans la clé privée Firebase
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

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

// ⚠️ Middleware JSON sauf pour /api/webhook
app.use((req, res, next) => {
  if (req.originalUrl === "/api/webhook") {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// -----------------------------
// Map PriceID → Role
// -----------------------------
const PLAN = {
  "price_1Rt7ErFD9N3apMZl5ZJra4sW": "community",
  "price_1Rt7ILFD9N3apMZlt1kpm4Lx": "biz",
  "price_1RtmDdFD9N3apMZlul64n316": "community",
  "price_1RtmDpFD9N3apMZl6QpQyaQt": "biz",

  // LIVE
  "price_live_xxx": "community",
  "price_live_yyy": "biz",
};

// Fallback montant
const PLAN_BY_AMOUNT = {
  1000: "community",
  3500: "biz",
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

    if (
      event.type === "checkout.session.completed" ||
      event.type === "invoice.paid"
    ) {
      const session = event.data.object;

      const customerEmail =
        session?.customer_details?.email || session?.customer_email;

      let priceId = null;

      // 1. Line items
      try {
        const lineItems = await stripe.checkout.sessions.listLineItems(
          session.id,
          { limit: 1 }
        );
        priceId = lineItems.data[0]?.price?.id || null;
      } catch (err) {
        console.error("❌ Impossible de récupérer les line_items:", err);
      }

      // 2. Subscription fallback
      if (!priceId && session?.subscription) {
        try {
          const subscription = await stripe.subscriptions.retrieve(
            session.subscription
          );
          priceId = subscription.items.data[0]?.price.id || null;
        } catch (err) {
          console.error("❌ Impossible de récupérer la subscription:", err);
        }
      }

      // 3. Montant fallback
      const amountCents =
        session.amount_total ||
        session.total ||
        session.amount_paid ||
        session.amount_due ||
        null;

      let role = "member";
      if (priceId && PLAN[priceId]) {
        role = PLAN[priceId];
      } else if (amountCents && PLAN_BY_AMOUNT[amountCents]) {
        role = PLAN_BY_AMOUNT[amountCents];
      }

      console.log(
        `📦 Event Stripe: ${event.type} | email=${customerEmail} | priceId=${priceId} | role=${role}`
      );

      try {
        if (!customerEmail) {
          console.warn("❌ Email introuvable dans la session Stripe");
        } else {
          const snapshot = await db
            .collection("users")
            .where("email", "==", customerEmail)
            .get();

          if (!snapshot.empty) {
            const userDoc = snapshot.docs[0];
            await userDoc.ref.update({ role });
            console.log(`✅ Firestore: rôle '${role}' mis à jour pour ${customerEmail}`);
          } else {
            console.warn(`❌ Firestore: utilisateur non trouvé (${customerEmail})`);
          }
        }
      } catch (err) {
        console.error("🔥 Erreur Firestore:", err);
      }
    }

    res.status(200).json({ received: true });
  }
);

// 👉 Export pour Vercel
export default app;
