const admin = require("firebase-admin");
const axios = require("axios");

if (admin.apps.length === 0) {
    admin.initializeApp();
}

async function executeTM30Submission(appId, submissionDocId) {
    const db = admin.firestore();
    
    // Grab the passport data from Firestore
    const docRef = db.collection("artifacts").doc(appId).collection("public").doc("data").collection("submissions").doc(submissionDocId);
    const snapshot = await docRef.get();
    if (!snapshot.exists) throw new Error(`Target submission ${submissionDocId} not found.`);
    
    const guestData = snapshot.data();

    // LIVE DESK MODE: Send brief confirmation to phone.
    if (guestData.chatId && process.env.TELEGRAM_BOT_TOKEN) {
        
        const shortMessage = `✅ *Passport Processed!*\nThe details for *${guestData.firstName || "the guest"}* have been synced to your Web Dashboard. 💻`;

        try {
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: guestData.chatId,
                text: shortMessage,
                parse_mode: "Markdown"
            });
            console.log("Live desk confirmation sent to Telegram.");
        } catch (e) {
            console.error("Failed to send telegram confirmation:", e.message);
        }
    }

    // Update database so the frontend knows it's waiting for manual human action
    await docRef.update({
        status: "manual_action_required",
        processedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return { success: true, mode: "live_desk" };
}

module.exports = { executeTM30Submission };
