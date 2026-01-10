/**
 * Firebase Functions with Secrets for Nodemailer
 */

const { onCall } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2/options");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const vision = require("@google-cloud/vision");
const nodemailer = require("nodemailer");

// Firebase initialize
admin.initializeApp();
const client = new vision.ImageAnnotatorClient();

setGlobalOptions({ maxInstances: 10 });

const GMAIL_EMAIL = defineSecret("GMAIL_EMAIL");
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

/**
 * analyzeGarbageImage Function - With Gemini AI as fallback
 */
exports.analyzeGarbageImage = onCall(
  {
    secrets: [GEMINI_API_KEY],
  },
  async (request) => {
    try {
      const { imageUri } = request.data;

      if (!imageUri) {
        throw new Error("imageUri is required");
      }

      const garbageKeywords = {
        "Dead Animals": [
          "animal",
          "dead",
          "carcass",
          "corpse",
          "pet",
          "wildlife",
          "bird",
          "dog",
          "cat",
        ],
        "Garbage Collection": [
          "garbage",
          "trash",
          "waste",
          "litter",
          "rubbish",
          "debris",
          "dump",
          "refuse",
        ],
        "Clean Public Space": [
          "public",
          "space",
          "area",
          "park",
          "street",
          "road",
          "sidewalk",
          "pathway",
        ],
        "Overflowing Dustbins": [
          "dustbin",
          "bin",
          "overflow",
          "overflowing",
          "full",
          "container",
          "dumpster",
          "trash can",
        ],
        "Construction Waste": [
          "construction",
          "debris",
          "concrete",
          "brick",
          "cement",
          "rubble",
          "building material",
          "demolition",
        ],
        "Plastic Waste": [
          "plastic",
          "bottle",
          "bag",
          "container",
          "packaging",
          "wrapper",
          "polythene",
          "styrofoam",
        ],
        "Organic Waste": [
          "food",
          "organic",
          "vegetable",
          "fruit",
          "leftover",
          "rotten",
          "compost",
          "biodegradable",
        ],
        "Drain Cleaning": [
          "drain",
          "sewer",
          "gutter",
          "manhole",
          "drainage",
          "blocked",
          "clogged",
          "water",
        ],
      };

      // Try Google Vision first
      try {
        logger.info("Using Google Vision for analysis");

        const [labelResult] = await client.labelDetection(imageUri);
        const [objectResult] = await client.objectLocalization(imageUri);

        const labels = labelResult.labelAnnotations || [];
        const objects = objectResult.localizedObjectAnnotations || [];

        let isGarbageDetected = false;
        let category = "Garbage Collection";
        let maxScore = 0;
        let detectedItems = [];

        labels.forEach((label) => {
          const desc = label.description.toLowerCase();
          detectedItems.push(label.description);

          Object.keys(garbageKeywords).forEach((cat) => {
            if (
              garbageKeywords[cat].some((keyword) => desc.includes(keyword))
            ) {
              isGarbageDetected = true;
              if (label.score > maxScore) {
                maxScore = label.score;
                category = cat;
              }
            }
          });
        });

        if (!isGarbageDetected) {
          return {
            isGarbage: false,
            category: null,
            severity: null,
            confidence: 0,
            description:
              "No garbage detected in the image. Please capture an image with visible waste or garbage.",
            detectedLabels: detectedItems.slice(0, 5),
            objectCount: 0,
            analyzedBy: "vision",
          };
        }

        const objectCount = objects.length;
        const avgConfidence =
          labels.reduce((sum, l) => sum + l.score, 0) / labels.length;

        let severity = "Medium";
        if (objectCount > 5 && avgConfidence > 0.8) severity = "High";
        else if (objectCount <= 2 || avgConfidence < 0.5) severity = "Low";

        const description = `Detected: ${labels
          .slice(0, 3)
          .map((l) => l.description)
          .join(", ")}. ${objectCount} items identified.`;

        return {
          isGarbage: true,
          category,
          severity,
          confidence: parseFloat(avgConfidence.toFixed(2)),
          description,
          detectedLabels: detectedItems.slice(0, 5),
          objectCount,
          analyzedBy: "vision",
        };
      } catch (visionError) {
        logger.warn(
          "Google Vision failed, falling back to Gemini AI:",
          visionError.message
        );

        // Fallback to Gemini AI
        try {
          logger.info("Attempting analysis with Gemini AI");

          // Convert Firebase Storage URL to base64
          let base64Image = "";

          if (
            imageUri.startsWith("http://") ||
            imageUri.startsWith("https://")
          ) {
            // Fetch the image from URL and convert to base64
            const imageResponse = await fetch(imageUri);
            const imageBuffer = await imageResponse.arrayBuffer();
            base64Image = Buffer.from(imageBuffer).toString("base64");
          } else if (imageUri.includes("base64,")) {
            // Already base64
            base64Image = imageUri.split("base64,")[1];
          } else {
            // Assume it's already base64
            base64Image = imageUri;
          }

          const categoryList = Object.keys(garbageKeywords).join(", ");

          const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY.value()}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                contents: [
                  {
                    parts: [
                      {
                        text: `Analyze this image and determine if it contains garbage or waste. You MUST classify it into EXACTLY ONE of these categories (use the exact name): ${categoryList}. 

Also determine the severity (Low, Medium, High) based on the amount and type of waste:
- High: Large amount of waste, overflowing, multiple types
- Medium: Moderate amount of waste
- Low: Small amount or minimal waste

Provide a brief description of what you see and list the detected items.

Respond ONLY with valid JSON in this exact format:
{
  "isGarbage": true or false,
  "category": "exact category name from the list above",
  "severity": "Low" or "Medium" or "High",
  "description": "brief description of what you see",
  "detectedItems": ["item1", "item2", "item3"],
  "confidence": 0.0 to 1.0
}`,
                      },
                      {
                        inlineData: {
                          mimeType: "image/jpeg",
                          data: base64Image,
                        },
                      },
                    ],
                  },
                ],
              }),
            }
          );

          const geminiData = await geminiResponse.json();

          if (geminiData.candidates && geminiData.candidates[0]) {
            const textContent = geminiData.candidates[0].content.parts[0].text;

            // Extract JSON from the response (handle markdown code blocks)
            let jsonText = textContent;
            if (textContent.includes("```json")) {
              jsonText = textContent.split("```json")[1].split("```")[0].trim();
            } else if (textContent.includes("```")) {
              jsonText = textContent.split("```")[1].split("```")[0].trim();
            }

            const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const result = JSON.parse(jsonMatch[0]);

              // Validate category is in our list
              const validCategories = Object.keys(garbageKeywords);
              if (!validCategories.includes(result.category)) {
                // Try to match to closest category
                result.category = "Garbage Collection"; // Default fallback
              }

              logger.info("Gemini AI analysis successful");

              return {
                isGarbage: result.isGarbage,
                category: result.category,
                severity: result.severity,
                confidence: result.confidence || 0.85,
                description: result.description,
                detectedLabels: result.detectedItems || [],
                objectCount: result.detectedItems?.length || 0,
                analyzedBy: "gemini",
              };
            }
          }

          throw new Error("Gemini response format invalid");
        } catch (geminiError) {
          logger.error("Gemini AI also failed:", geminiError.message);
          throw new Error(
            "Both Vision and Gemini AI failed to analyze the image"
          );
        }
      }
    } catch (error) {
      logger.error("Image analysis error:", error);
      throw new Error("Failed to analyze image: " + error.message);
    }
  }
);

exports.createWorker = onCall(
  {
    secrets: [GMAIL_EMAIL, GMAIL_APP_PASSWORD],
  },
  async (request) => {
    try {
      const { email, password, name, phone, ngoId } = request.data;

      logger.info("Create worker request for:", email, name, phone);

      // Create Firebase Auth user
      const userRecord = await admin.auth().createUser({
        email,
        password,
        displayName: name,
      });

      // Firestore document
      await admin.firestore().collection("users").doc(userRecord.uid).set({
        uid: userRecord.uid,
        email,
        name,
        ngoId,
        phone,
        role: "worker",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Nodemailer using Secrets
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: GMAIL_EMAIL.value(),
          pass: GMAIL_APP_PASSWORD.value(),
        },
      });

      const mailOptions = {
        from: `SwachhSathi <${GMAIL_EMAIL.value()}>`,
        to: email,
        subject: "Welcome to SwachhSathi - Worker Account Created",
        html: `
          <div style="font-family: Arial; max-width: 600px;">
            <h2>Welcome to SwachhSathi!</h2>
            <p>Hi ${name},</p>
            <p>Your worker account has been successfully created.</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Password:</strong> ${password}</p>
            <p>Please change your password after first login.</p>
          </div>
        `,
      };

      await transporter.sendMail(mailOptions);

      return {
        success: true,
        uid: userRecord.uid,
        message: "Worker account created successfully",
      };
    } catch (error) {
      logger.error("Create worker error:", error);
      throw new Error(error.message);
    }
  }
);

exports.compareBeforeAfter = onCall(async (request) => {
  try {
    const { beforeImageUrl, afterImageUrl } = request.data;

    if (!beforeImageUrl || !afterImageUrl) {
      throw new Error("Both before and after image URLs are required");
    }

    // Analyze both images
    const [beforeResult] = await client.labelDetection(beforeImageUrl);
    const [afterResult] = await client.labelDetection(afterImageUrl);

    const beforeLabels = beforeResult.labelAnnotations.map((label) =>
      label.description.toLowerCase()
    );
    const afterLabels = afterResult.labelAnnotations.map((label) =>
      label.description.toLowerCase()
    );

    // Garbage-related keywords
    const garbageKeywords = [
      "waste",
      "garbage",
      "trash",
      "litter",
      "rubbish",
      "debris",
      "plastic",
      "bottle",
      "bag",
      "wrapper",
      "container",
      "pollution",
    ];

    // Count garbage indicators in both images
    const beforeGarbageCount = beforeLabels.filter((label) =>
      garbageKeywords.some((keyword) => label.includes(keyword))
    ).length;

    const afterGarbageCount = afterLabels.filter((label) =>
      garbageKeywords.some((keyword) => label.includes(keyword))
    ).length;

    // Clean indicators
    const cleanKeywords = [
      "clean",
      "tidy",
      "neat",
      "organized",
      "clear",
      "empty",
    ];
    const afterCleanCount = afterLabels.filter((label) =>
      cleanKeywords.some((keyword) => label.includes(keyword))
    ).length;

    // Calculate cleanliness score (0-100)
    const garbageReduction = Math.max(
      0,
      beforeGarbageCount - afterGarbageCount
    );
    const cleanlinessScore = Math.min(
      100,
      Math.round(
        (garbageReduction / Math.max(beforeGarbageCount, 1)) * 60 +
          afterCleanCount * 10 +
          (afterGarbageCount === 0 ? 20 : 0)
      )
    );

    // Determine if area is clean enough
    const isClean =
      cleanlinessScore >= 70 ||
      (afterGarbageCount === 0 && beforeGarbageCount > 0);

    let message;
    if (isClean) {
      message = "Great job! The area has been successfully cleaned.";
    } else if (cleanlinessScore >= 50) {
      message = "Good progress, but the area needs more cleaning.";
    } else {
      message =
        "The area still appears to have significant garbage. Please clean more thoroughly.";
    }

    return {
      isClean,
      message,
      cleanlinessScore,
      beforeLabels: beforeLabels.slice(0, 10),
      afterLabels: afterLabels.slice(0, 10),
      garbageReduction,
      beforeGarbageCount,
      afterGarbageCount,
    };
  } catch (error) {
    console.error("Error comparing images:", error);
    throw new Error("Failed to compare images: " + error.message);
  }
});

exports.autoAssignNearestWorker = onDocumentCreated(
  "reports/{reportId}",
  async (event) => {
    const report = event.data.data();
    const reportId = event.params.reportId;

    if (
      !report ||
      !report.location ||
      !report.location.latitude ||
      !report.location.longitude
    ) {
      logger.info("Report location missing, skipping assignment.");
      return;
    }

    if (!report.category) {
      logger.info("Report category missing, skipping assignment.");
      return;
    }

    // Step 1: Find NGOs that handle this category
    const ngosSnap = await admin
      .firestore()
      .collection("ngos")
      .where("categories", "array-contains", report.category)
      .get();

    if (ngosSnap.empty) {
      logger.info(`No NGOs found that handle category: ${report.category}`);
      return;
    }

    // Step 2: Get all ngoIds that match
    const matchingNgoIds = ngosSnap.docs.map((doc) => doc.id);
    logger.info(
      `Found ${matchingNgoIds.length} NGOs for category ${report.category}`
    );

    // Step 3: Fetch all active workers from these NGOs
    const workersSnap = await admin
      .firestore()
      .collection("users")
      .where("role", "==", "worker")
      .where("isActive", "==", true)
      .where("ngoId", "in", matchingNgoIds)
      .get();

    if (workersSnap.empty) {
      logger.info("No active workers found for matching NGOs.");
      return;
    }

    // Haversine formula to calculate distance between two lat/lng points
    function getDistance(lat1, lon1, lat2, lon2) {
      function toRad(x) {
        return (x * Math.PI) / 180;
      }
      const R = 6371; // km
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) *
          Math.cos(toRad(lat2)) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    }

    let nearestWorker = null;
    let minDistance = Number.POSITIVE_INFINITY;

    workersSnap.forEach((doc) => {
      const worker = doc.data();
      if (
        worker.currentLocation &&
        worker.currentLocation.latitude &&
        worker.currentLocation.longitude
      ) {
        const dist = getDistance(
          report.location.latitude,
          report.location.longitude,
          worker.currentLocation.latitude,
          worker.currentLocation.longitude
        );
        if (dist < minDistance) {
          minDistance = dist;
          nearestWorker = {
            uid: worker.uid,
            name: worker.name,
            email: worker.email,
            ngoId: worker.ngoId,
            distance: dist,
          };
        }
      }
    });

    if (!nearestWorker) {
      logger.info("No workers with valid location found.");
      return;
    }

    // Assign the report to the nearest worker
    await admin.firestore().collection("reports").doc(reportId).update({
      assignedTo: nearestWorker.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(
      `Report ${reportId} assigned to worker ${nearestWorker.uid} (${
        nearestWorker.name
      }) from NGO ${nearestWorker.ngoId}, distance: ${minDistance.toFixed(
        2
      )} km`
    );
  }
);

/**
 * Send notification when report status changes to resolved
 */
exports.onReportResolved = onDocumentUpdated(
  "reports/{reportId}",
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    // Check if status changed to resolved
    if (
      before.status !== "resolved" &&
      after.status === "resolved" &&
      after.userId
    ) {
      try {
        // Get user's FCM token
        const userDoc = await admin
          .firestore()
          .collection("users")
          .doc(after.userId)
          .get();

        const userData = userDoc.data();
        const fcmToken = userData?.fcmToken;

        if (!fcmToken) {
          logger.info("User has no FCM token");
          return null;
        }

        // Send notification
        const message = {
          notification: {
            title: "Report Resolved",
            body: "Your garbage collection report has been successfully resolved. Thank you for keeping our community clean!",
          },
          data: {
            reportId: event.params.reportId,
            type: "report_resolved",
          },
          token: fcmToken,
        };

        await admin.messaging().send(message);
        logger.info("Resolution notification sent to user");
      } catch (error) {
        logger.error("Error sending resolution notification:", error);
      }
    }

    return null;
  }
);
/**
 * Send welcome notification when a new worker is created
 */
exports.onWorkerCreated = onDocumentCreated("users/{userId}", async (event) => {
  const userData = event.data.data();

  // Check if new user is a worker
  if (userData.role === "worker" && userData.fcmToken) {
    try {
      const message = {
        notification: {
          title: "Welcome to SwachhSathi",
          body: "Your worker account has been created. Start making a difference in your community!",
        },
        data: {
          type: "worker_welcome",
        },
        token: userData.fcmToken,
      };

      await admin.messaging().send(message);
      logger.info("Welcome notification sent to new worker");
    } catch (error) {
      logger.error("Error sending welcome notification:", error);
    }
  }

  return null;
});

/**
 * Send notification to worker when a report is assigned to them
 */
exports.onReportAssigned = onDocumentUpdated(
  "reports/{reportId}",
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const reportId = event.params.reportId;

    // Check if assignedTo field changed from null/undefined to a worker uid
    if (!before.assignedTo && after.assignedTo) {
      try {
        // Get worker's FCM token
        const workerDoc = await admin
          .firestore()
          .collection("users")
          .doc(after.assignedTo)
          .get();

        if (!workerDoc.exists) {
          logger.info("Worker not found");
          return null;
        }

        const workerData = workerDoc.data();
        const fcmToken = workerData?.fcmToken;

        if (!fcmToken) {
          logger.info("Worker has no FCM token");
          return null;
        }

        // Send notification to worker
        const message = {
          notification: {
            title: "New Task Assigned",
            body: `You have been assigned a new ${after.category} task. Severity: ${after.severity}`,
          },
          data: {
            reportId: reportId,
            type: "task_assigned",
            category: after.category || "",
            severity: after.severity || "",
            address: after.location?.address || "",
            latitude: String(after.location?.latitude || ""),
            longitude: String(after.location?.longitude || ""),
          },
          token: fcmToken,
        };

        await admin.messaging().send(message);
        logger.info(
          `Task assignment notification sent to worker ${after.assignedTo}`
        );
      } catch (error) {
        logger.error("Error sending task assignment notification:", error);
      }
    }

    return null;
  }
);
