const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const axios = require("axios");

/* STREAMING_CHUNK:Initializing Firebase and setup variables... */
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

const telegramToken = defineSecret("TELEGRAM_BOT_TOKEN");
const geminiApiKey = defineSecret("GEMINI_API_KEY");

function sanitizeSecret(secret) {
    return secret ? secret.trim() : "";
}

async function sendTelegramText(chatId, text, token) {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: text,
        parse_mode: "Markdown"
    });
}

/* STREAMING_CHUNK:Defining the main Telegram Webhook... */
exports.telegramBotWebhook = onRequest({
    secrets: ["TELEGRAM_BOT_TOKEN", "GEMINI_API_KEY"],
    region: "asia-southeast1", 
    memory: "256MiB", 
    timeoutSeconds: 60    
}, async (req, res) => {
    try {
        const payload = req.body;
        if (!payload || !payload.message) {
            return res.status(200).send({ ok: false });
        }

        const message = payload.message;
        const chatId = message.chat.id;
        const messageId = message.message_id.toString();
        
        /* STREAMING_CHUNK:Preventing duplicate processing... */
        const dedupeRef = db.collection("system").doc("telegram_cache").collection("processed").doc(messageId);
        const dedupeSnap = await dedupeRef.get();
        if (dedupeSnap.exists) {
            return res.status(200).send({ ok: true });
        }
        await dedupeRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp() });

        const botToken = sanitizeSecret(telegramToken.value());
        const geminiKey = sanitizeSecret(geminiApiKey.value());

        /* STREAMING_CHUNK:Setting up property routing logic... */
        const chatMappingRef = db.collection("system").doc("chat_mappings").collection("chats").doc(chatId.toString());

        if (message.text && message.text.startsWith("/setproperty")) {
            const propertyName = message.text.split(" ")[1];
            if (!propertyName) {
                await sendTelegramText(chatId, "⚠️ Please specify a property.\n\nExample: `/setproperty SWIMS` or `/setproperty WET`", botToken);
                return res.status(200).send({ ok: true });
            }
            await chatMappingRef.set({ property: propertyName.toUpperCase() });
            await sendTelegramText(chatId, `✅ Success! This group chat is now permanently linked to: *${propertyName.toUpperCase()}*\n\nAll passports sent here will automatically be tagged for this property on the Dashboard.`, botToken);
            return res.status(200).send({ ok: true });
        }

        /* STREAMING_CHUNK:Handling standard commands... */
        if (message.text && message.text.startsWith("/start")) {
            await sendTelegramText(chatId, "Sawadee krap! Welcome to the TM30 Submitter.\n\nSend me a flat, clear photo of a guest's passport biographical page to extract their details to the Web Dashboard.", botToken);
            return res.status(200).send({ ok: true });
        }

        /* STREAMING_CHUNK:Processing incoming passport photos... */
        if (message.photo) {
            await sendTelegramText(chatId, "📥 Passport photo received! Extracting details...", botToken);

            if (!botToken || !geminiKey) throw new Error("Missing API keys in Secret Manager.");

            const photoArray = message.photo;
            const targetPhoto = photoArray[photoArray.length - 1]; 
            const fileId = targetPhoto.file_id;

            const infoResponse = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
            const filePath = infoResponse.data.result.file_path;
            const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

            const downloadResponse = await axios.get(fileUrl, { responseType: "arraybuffer" });
            const imageBase64 = Buffer.from(downloadResponse.data).toString("base64");

            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
            const prompt = `Analyze this passport biographical page. Extract the fields and return them strictly inside a valid flat JSON block containing: 
            firstName, 
            lastName, 
            passportNumber, 
            nationality (IMPORTANT: Convert the country into the standard English demonym used in Asian immigration forms. e.g., USA becomes 'AMERICAN', UK becomes 'BRITISH', France becomes 'FRENCH', Germany becomes 'GERMAN'), 
            dobDay (2-digit day), 
            dobMonth (2-digit month), 
            dobYear (4-digit year), 
            gender (Male or Female). 
            Do not include Markdown formatting. Output only RAW JSON.`;

            const geminiPayload = {
                contents: [{
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: "image/jpeg", data: imageBase64 } }
                    ]
                }],
                generationConfig: { responseMimeType: "application/json" }
            };

            /* STREAMING_CHUNK:Sending payload to AI and parsing response safely... */
            let guestData;
            try {
                const geminiResponse = await axios.post(geminiUrl, geminiPayload, { headers: { "Content-Type": "application/json" } });
                let outputText = geminiResponse.data.candidates[0].content.parts[0].text;
                
                outputText = outputText.replace(/`{3}[a-zA-Z]*\n?/gi, '').replace(/`{3}\n?/g, '').trim();
                guestData = JSON.parse(outputText);
            } catch (extractErr) {
                console.error("Gemini Extraction Error:", extractErr);
                await sendTelegramText(chatId, `❌ *AI Extraction Failed:*\n\nCould not read the passport cleanly. Please ensure the photo is flat and glare-free.\n\n_System Error: ${extractErr.message}_`, botToken);
                return res.status(200).send({ ok: true });
            }

            const summaryText = `🔍 *Extracted Passport Details:*\n` +
                `• *Name:* ${guestData.firstName || "N/A"} ${guestData.lastName || ""}\n` +
                `• *Passport No:* \`${guestData.passportNumber || "N/A"}\`\n` +
                `• *Nationality:* ${guestData.nationality || "N/A"}\n` +
                `• *DOB:* ${guestData.dobDay || "-"}/${guestData.dobMonth || "-"}/${guestData.dobYear || "-"}\n` +
                `• *Gender:* ${guestData.gender || "N/A"}\n\n` +
                `⚙ *Pushing to Web Dashboard...*`;
            
            await sendTelegramText(chatId, summaryText, botToken);

            /* STREAMING_CHUNK:Tagging the property and saving to database... */
            let chatProperty = "UNASSIGNED";
            const mappingSnap = await chatMappingRef.get();
            if (mappingSnap.exists) {
                chatProperty = mappingSnap.data().property;
            }

            const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
            let docRef;
            try {
                docRef = await db.collection("artifacts")
                    .doc(appId)
                    .collection("public")
                    .doc("data")
                    .collection("submissions")
                    .add({
                        property: chatProperty,
                        firstName: (guestData.firstName || "").toUpperCase(),
                        lastName: (guestData.lastName || "").toUpperCase(),
                        passportNumber: (guestData.passportNumber || "").toUpperCase().replace(/\s/g, ''),
                        nationality: (guestData.nationality || "").toUpperCase(),
                        dobDay: guestData.dobDay || "",
                        dobMonth: guestData.dobMonth || "",
                        dobYear: guestData.dobYear || "",
                        gender: (guestData.gender || "").toUpperCase(),
                        status: "processing", 
                        chatId: chatId,
                        createdAt: admin.firestore.FieldValue.serverTimestamp()
                    });
            } catch (dbErr) {
                console.error("Database Save Error:", dbErr);
                await sendTelegramText(chatId, `❌ *Database Error:*\nFailed to queue the submission.`, botToken);
                return res.status(200).send({ ok: true });
            }

            /* STREAMING_CHUNK:Triggering dashboard alert... */
            const docId = docRef.id;
            try {
                const scraperModule = require("./scraper");
                await scraperModule.executeTM30Submission(appId, docId);
            } catch (err) {
                console.error("Scraper execution crashed:", err);
                await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    chat_id: chatId,
                    text: `❌ Dashboard Push Failed:\n\n${err.message.substring(0, 800)}` 
                });
            }

            return res.status(200).send({ ok: true });
        }

        return res.status(200).send({ ok: true });

    } catch (error) {
        console.error("Cloud function webhook handler crashed:", error);
        return res.status(200).send({ ok: true });
    }
});
