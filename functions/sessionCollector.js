// functions/sessionCollector.js

const admin = require('firebase-admin');

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            // Replace escaped "\n" with actual newlines in the private key
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
    });
}

const db = admin.firestore();

// Session timeout duration (5 minutes)

// Dynamic CORS header generator
function getCorsHeaders(origin) {
    // For local development - explicitly allow your frontend origin
    const allowedOrigins = [
        'http://127.0.0.1:5501',  // Your frontend's origin
        'http://localhost:5501'   // Alternative way to access your frontend
    ];

    // If the request is from an allowed origin, use that; otherwise use '*' in development
    const allowedOrigin = allowedOrigins.includes(origin)
        ? origin
        : (process.env.NODE_ENV === 'development' ? '*' : null);

    return {
        'Access-Control-Allow-Origin': allowedOrigin || '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
        'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
        'Access-Control-Max-Age': '86400',
        'Content-Type': 'application/json'
    };
}

exports.handler = async (event, context) => {
    // Generate CORS headers based on the request's origin header
    const headers = getCorsHeaders(event.headers?.origin || event.headers?.Origin);

    // Handle OPTIONS request for CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204, // No content needed for preflight response
            headers,
            body: ''
        };
    }

    try {
        // Parse body safely
        let body;
        try {
            body = JSON.parse(event.body || "{}");
        } catch (parseError) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Invalid JSON in request body" }),
            };
        }

        let { apiKey, tinyCode, fingerprint, data, action, websiteName } = body;

        // 1. Type-check & normalize fingerprint
        if (typeof fingerprint === 'number') {
            // convert number → string
            fingerprint = fingerprint.toString();
        } else if (typeof fingerprint !== 'string') {
            // immediately reject any non-string/non-number
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Fingerprint must be a string or number." })
            };
        }

        // 2. Trim whitespace & ensure it’s not empty
        fingerprint = fingerprint.trim();
        if (!fingerprint) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Fingerprint missing." }),
            };
        }

        // Reference to the fingerprint document and its sessions sub-collection
        const fingerprintDocRef = db.collection(websiteName).doc(fingerprint);
        const sessionsCollRef = fingerprintDocRef.collection('sessions');

        // Get the most recent session for this fingerprint (order by startedAt descending)
        const latestSessionSnap = await sessionsCollRef.orderBy('startedAt', 'desc').limit(1).get();

        let sessionRef;
        let newSessionStarted = false;

        // Append new data if provided (default action or explicit "append")
        if (data && (!action || action === 'append')) {

            if (latestSessionSnap.empty) {
                // No session exists yet for this fingerprint – create the first session document
                newSessionStarted = true;
            } else {
                // A session exists – check if the last session has ended
                const lastSessionDoc = latestSessionSnap.docs[0];
                const lastSessionData = lastSessionDoc.data();
                if (lastSessionData.endedAt !== null && lastSessionData.endedAt !== undefined) {
                    // Last session has an endedAt timestamp, so start a new session
                    newSessionStarted = true;
                } else {
                    // Last session is still active (endedAt is null)
                    sessionRef = lastSessionDoc.ref;
                }
            }

            if (newSessionStarted) {
                // Start a new session document in the sub-collection
                sessionRef = sessionsCollRef.doc();  // generate a new session document with an auto ID
                const now = admin.firestore.FieldValue.serverTimestamp();
                await sessionRef.set({
                    apiKey: apiKey,
                    tinyCode: tinyCode,
                    startedAt: now,
                    lastActivity: now,
                    endedAt: null,
                    dataBatches: Array.isArray(data) ? data : [data]
                });
            } else {
                // Append data to the active session document
                if (Array.isArray(data)) {
                    await sessionRef.update({
                        lastActivity: admin.firestore.FieldValue.serverTimestamp(),
                        dataBatches: admin.firestore.FieldValue.arrayUnion(...data)
                    });
                } else {
                    await sessionRef.update({
                        lastActivity: admin.firestore.FieldValue.serverTimestamp(),
                        dataBatches: admin.firestore.FieldValue.arrayUnion(data)
                    });
                }
            }

            // Prepare a response indicating what action was taken
            const response = {
                success: true,
                message: newSessionStarted
                    ? "Started a new session and recorded data."
                    : "Added data to the existing active session.",
                newSessionStarted: newSessionStarted
            };

            return {
                statusCode: 200,
                headers: headers,
                body: JSON.stringify(response)
            };


        }

        // End the session if the "end" action is provided
        if (action === 'end') {
            // Retrieve the latest session to end
            const latestSessionSnapForEnd = await sessionsCollRef.orderBy('startedAt', 'desc').limit(1).get();
            if (latestSessionSnapForEnd.empty) {
                return {
                    statusCode: 404,
                    headers,
                    body: JSON.stringify({ error: "No active session found for this fingerprint." })
                };
            }
            const lastSessionDoc = latestSessionSnapForEnd.docs[0];
            const lastSessionData = lastSessionDoc.data();
            if (lastSessionData.endedAt !== null && lastSessionData.endedAt !== undefined) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: "Session has already ended." })
                };
            }
            // Set sessionRef to the active session document
            sessionRef = lastSessionDoc.ref;
            const now = admin.firestore.FieldValue.serverTimestamp();
            await sessionRef.update({
                endedAt: now,
                lastActivity: now,
            });
            const finalSession = (await sessionRef.get()).data();
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    message: "Session ended. Data stored in Firestore.",
                    session: finalSession,
                }),
            };
        }

        // Default response if no recognized action is provided
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ message: "Session not updated.", fingerprint }),
        };

    } catch (err) {
        console.error("Error in sessionCollector function:", err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: "Internal Server Error",
                details: err.message,
            }),
        };
    }
};