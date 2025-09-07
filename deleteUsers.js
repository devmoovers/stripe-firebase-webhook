// deleteUsers.js
import admin from "firebase-admin";
import fs from "fs";

// Charge la clé de service téléchargée depuis Firebase
const serviceAccount = JSON.parse(fs.readFileSync("./serviceAccountKey.json"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

async function deleteAllUsers(nextPageToken) {
  const listUsersResult = await admin.auth().listUsers(1000, nextPageToken);

  const uids = listUsersResult.users.map((user) => user.uid);

  if (uids.length) {
    const result = await admin.auth().deleteUsers(uids);
    console.log(`✅ Supprimé ${result.successCount} utilisateurs`);
    if (result.failureCount > 0) {
      console.error(`⚠️ Erreurs pour ${result.failureCount} utilisateurs`);
    }
  }

  if (listUsersResult.pageToken) {
    // Rappel récursif si >1000 utilisateurs
    await deleteAllUsers(listUsersResult.pageToken);
  }
}

deleteAllUsers()
  .then(() => {
    console.log("🎉 Tous les utilisateurs ont été supprimés !");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Erreur:", err);
    process.exit(1);
  });
