import express from "express";
import Stripe from "stripe";
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();
const app = express();

// Stripe webhook doit recevoir le body brut
app.post(
  "/webhook",
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

    // ✅ Quand le paiement est terminé
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerEmail = session.customer_details?.email;

      if (!customerEmail) {
        console.log("⚠️ Pas d'email dans la session Stripe");
      } else {
        try {
          // 🔍 Chercher l'utilisateur dans Firestore par email
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
          console.error("Erreur Firestore:", err);
        }
      }
    }

    res.json({ received: true });
  }
);

// ✅ Health check (utile pour tester sur Vercel/Render)
app.get("/", (req, res) => {
  res.send("🔥 Webhook server is running!");
});

app.listen(3000, () => {
  console.log("🚀 Serveur webhook démarré sur http://localhost:3000");
});
