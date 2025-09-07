import admin from "firebase-admin";
import fs from "fs";

// 🔥 Charge la clé de service Firebase
const serviceAccount = JSON.parse(fs.readFileSync("./serviceAccountKey.json"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// -----------------------------
// Générateur de code parrainage
// -----------------------------
const generateReferralCode = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "MOOV-";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

// -----------------------------
// Vérifie l’unicité du code
// -----------------------------
const getUniqueReferralCode = async () => {
  let code = generateReferralCode();
  let exists = true;

  while (exists) {
    const snap = await db.collection("users").where("referralCode", "==", code).get();
    exists = !snap.empty;
    if (exists) {
      code = generateReferralCode();
    }
  }

  return code;
};

// -----------------------------
// Ajoute un code à chaque user
// -----------------------------
async function addReferralCodes() {
  const snapshot = await db.collection("users").get();

  let updatedCount = 0;
  for (const doc of snapshot.docs) {
    const data = doc.data();

    if (!data.referralCode) {
      const code = await getUniqueReferralCode();

      await doc.ref.update({
        referralCode: code,   // 👈 code parrainage unique
        referralsCount: 0,
        freeMonths: 0,
        filleuls: [],
      });

      console.log(`✅ Code généré pour ${data.email || doc.id}: ${code}`);
      updatedCount++;
    }
  }

  console.log(`🎉 Terminé : ${updatedCount} utilisateurs mis à jour.`);
  process.exit(0);
}

addReferralCodes().catch((err) => {
  console.error("🔥 Erreur:", err);
  process.exit(1);
});
