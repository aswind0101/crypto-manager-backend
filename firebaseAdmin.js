import admin from "firebase-admin";
import serviceAccount from "./firebase-service-account.json" with { type: "json" };


if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export default admin;
