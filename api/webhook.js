import express from "express";
import Stripe from "stripe";
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

// ⚡️ Fix des "\n" dans la clé privée
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

// Stripe webhook doit recevoir le body brut
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

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerEmail = session.customer_details.email;

      try {
        const snapshot = await db
          .collection("users")
          .where("email", "==", customerEmail)
          .get();

        if (!snapshot.empty) {
          const userDoc = snapshot.docs[0];
          await userDoc.ref.update({ role: "biz" });
          console.log(`✅ Rôle mis à jour pour ${customerEmail}`);
        } else {
          console.log(`❌ Utilisateur non trouvé : ${customerEmail}`);
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
