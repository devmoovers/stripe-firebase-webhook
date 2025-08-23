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

// 🔐 Essayer les deux webhook secrets (TEST et LIVE)
const webhookSecrets = [
  process.env.STRIPE_WEBHOOK_SECRET,      // LIVE
  process.env.STRIPE_WEBHOOK_SECRET_TEST  // TEST
].filter(Boolean); // Enlève les valeurs vides/undefined

// -----------------------------
// Map PriceID → Role
// -----------------------------
const PLAN = {
  "price_1Rt7ErFD9N3apMZl5ZJra4sW": "community",
  "price_1Rt7ILFD9N3apMZlt1kpm4Lx": "biz",
  "price_1RtmDdFD9N3apMZlul64n316": "community",
  "price_1RtmDpFD9N3apMZl6QpQyaQt": "biz",
};

// Fallback par montant (au cas où)
const PLAN_BY_AMOUNT = {
  1000: "community", // 10€
  3500: "biz",       // 35€
};

// -----------------------------
// Configuration Vercel CRITIQUE
// -----------------------------
export const config = {
  api: {
    bodyParser: false, // ⚠️ OBLIGATOIRE : désactiver pour avoir le raw body
  },
};

// -----------------------------
// Fonction pour lire le raw body
// -----------------------------
const getRawBody = (req) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
};

// -----------------------------
// Webhook Stripe FINAL
// -----------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    console.log("❌ Method not allowed:", req.method);
    return res.status(405).send("Method Not Allowed");
  }

  console.log("📨 Webhook reçu");
  console.log("🔍 Headers:", JSON.stringify(req.headers, null, 2));

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    console.log("❌ Signature manquante");
    return res.status(400).send("No signature header");
  }

  let event;
  let body;

  try {
    // 📖 Lire le raw body
    body = await getRawBody(req);
    console.log("📦 Body reçu, taille:", body.length);

    // 🔐 Essayer avec chaque webhook secret
    let eventConstructed = false;
    for (const secret of webhookSecrets) {
      try {
        event = stripe.webhooks.constructEvent(body, sig, secret);
        console.log("✅ Event validé avec secret:", secret.substring(0, 12) + "...");
        eventConstructed = true;
        break; // Succès, on s'arrête
      } catch (err) {
        console.log("❌ Échec avec secret:", secret.substring(0, 12) + "...", err.message);
        continue; // Essayer le prochain secret
      }
    }

    if (!eventConstructed) {
      throw new Error("Aucun webhook secret ne fonctionne");
    }

    console.log("✅ Event validé:", event.type);
  } catch (err) {
    console.error("⚠️ Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ---------------------------
  // Gestion des paiements réussis
  // ---------------------------
  if (event.type === "checkout.session.completed" || event.type === "invoice.paid") {
    const session = event.data.object;
    console.log("💳 Session:", {
      id: session.id,
      customer: session.customer,
      subscription: session.subscription,
      amount_total: session.amount_total,
      mode: session.mode
    });

    // ✅ Récup email - plus robuste
    const customerEmail = 
      session?.customer_details?.email || 
      session?.customer_email;

    if (!customerEmail) {
      console.warn("❌ Pas d'email trouvé dans la session");
      return res.status(200).json({ received: true, warning: "No email found" });
    }

    let priceId = null;

    // 🔎 1. Essayer de récupérer le PriceID via lineItems
    try {
      if (session.mode === "subscription" || session.subscription) {
        // Pour les abonnements
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        priceId = subscription.items.data[0]?.price.id;
        console.log("💡 PriceID depuis subscription:", priceId);
      } else {
        // Pour les paiements uniques
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
        priceId = lineItems.data[0]?.price?.id;
        console.log("💡 PriceID depuis lineItems:", priceId);
      }
    } catch (err) {
      console.error("❌ Erreur récupération priceId:", err.message);
    }

    // 🔎 2. Fallback par montant payé
    const amountCents = session.amount_total || session.total || 0;
    console.log("💰 Montant:", amountCents);

    // 🎯 Détermination du rôle
    let role = "member"; // défaut
    if (priceId && PLAN[priceId]) {
      role = PLAN[priceId];
      console.log(`🎯 Rôle depuis priceId: ${role}`);
    } else if (amountCents && PLAN_BY_AMOUNT[amountCents]) {
      role = PLAN_BY_AMOUNT[amountCents];
      console.log(`🎯 Rôle depuis montant: ${role}`);
    } else {
      console.warn(`❓ Pas de rôle trouvé pour priceId=${priceId}, montant=${amountCents}`);
    }

    console.log(`📦 Traitement: email=${customerEmail} | priceId=${priceId} | role=${role}`);

    // ✅ Mise à jour Firestore
    try {
      const snapshot = await db.collection("users").where("email", "==", customerEmail).get();

      if (!snapshot.empty) {
        const userDoc = snapshot.docs[0];
        const currentData = userDoc.data();
        
        await userDoc.ref.update({ 
          role,
          lastPayment: admin.firestore.FieldValue.serverTimestamp(),
          stripeCustomerId: session.customer,
          subscriptionId: session.subscription || null
        });
        
        console.log(`✅ Firestore: rôle '${role}' mis à jour pour ${customerEmail}`);
        console.log(`📊 Données avant:`, JSON.stringify(currentData, null, 2));
      } else {
        console.warn(`❌ Firestore: utilisateur non trouvé (${customerEmail})`);
        // Option: créer l'utilisateur automatiquement
        /*
        await db.collection("users").add({
          email: customerEmail,
          role,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          stripeCustomerId: session.customer,
          subscriptionId: session.subscription || null
        });
        console.log(`✅ Utilisateur créé: ${customerEmail} avec rôle ${role}`);
        */
      }
    } catch (err) {
      console.error("🔥 Erreur Firestore:", err);
      return res.status(500).json({ error: "Database error", received: true });
    }
  } else {
    console.log(`ℹ️ Event non traité: ${event.type}`);
  }

  // ⚡ Toujours répondre à Stripe
  console.log("✅ Webhook traité avec succès");
  res.status(200).json({ received: true, eventType: event.type });
}