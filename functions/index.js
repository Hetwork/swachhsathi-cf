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
        isActive: false,
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

    // Assign the report to the nearest worker and add ngoId
    await admin.firestore().collection("reports").doc(reportId).update({
      assignedTo: nearestWorker.uid,
      ngoId: nearestWorker.ngoId,
      status: "assigned",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Add a status entry to the reportStatus subcollection with workerName and message
    await admin.firestore()
      .collection("reports")
      .doc(reportId)
      .collection("reportStatus")
      .add({
        status: "assigned",
        workerId: nearestWorker.uid,
        workerName: nearestWorker.name,
        message: `Status changed to assigned`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

    logger.info(
      `Report ${reportId} assigned to worker ${nearestWorker.uid} (${nearestWorker.name}) from NGO ${nearestWorker.ngoId}, distance: ${minDistance.toFixed(2)} km`
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
/**
 * Analyze waste image and classify it
 */
exports.analyzeWasteImage = onCall(async (request) => {
  try {
    const { imageUri } = request.data;

    if (!imageUri) {
      throw new Error('Image URI is required');
    }

    // Detect labels using Vision AI
    const [result] = await client.labelDetection(imageUri);
    const labels = result.labelAnnotations || [];

    // Analyze labels to determine waste type
    const wasteAnalysis = classifyWaste(labels);

    // Log for analytics
    if (request.auth) {
      await admin.firestore().collection('wasteScans').add({
        userId: request.auth.uid,
        imageUri,
        detectedType: wasteAnalysis.type,
        category: wasteAnalysis.category,
        confidence: wasteAnalysis.confidence,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return wasteAnalysis;
  } catch (error) {
    logger.error('Error analyzing waste image:', error);
    throw new Error('Failed to analyze image');
  }
});

/**
 * Classify waste based on detected labels
 */
function classifyWaste(labels) {
  const labelTexts = labels.map(l => l.description.toLowerCase());
  const maxConfidence = Math.max(...labels.map(l => l.score || 0));

  // Plastic detection
  if (labelTexts.some(l => ['plastic', 'bottle', 'container', 'packaging'].includes(l))) {
    return {
      type: 'Plastic Waste',
      category: 'recyclable',
      confidence: Math.round(maxConfidence * 100),
      recyclingInfo: 'Most plastic bottles and containers (labeled #1-7) are recyclable. Check your local recycling guidelines for specific types accepted.',
      disposalMethod: 'Rinse the plastic item, remove caps/lids, and place in your recycling bin. Look for the recycling symbol and number on the bottom.',
    };
  }

  // Paper/Cardboard detection
  if (labelTexts.some(l => ['paper', 'cardboard', 'box', 'newspaper', 'magazine'].includes(l))) {
    return {
      type: 'Paper/Cardboard',
      category: 'recyclable',
      confidence: Math.round(maxConfidence * 100),
      recyclingInfo: 'Paper and cardboard are highly recyclable materials. Keep them dry and clean for optimal recycling.',
      disposalMethod: 'Flatten cardboard boxes, remove any plastic tape or labels, and place in your recycling bin. Avoid soiled or greasy paper.',
    };
  }

  // Glass detection
  if (labelTexts.some(l => ['glass', 'jar', 'bottle', 'wine'].includes(l))) {
    return {
      type: 'Glass',
      category: 'recyclable',
      confidence: Math.round(maxConfidence * 100),
      recyclingInfo: 'Glass is 100% recyclable and can be recycled endlessly without loss of quality or purity.',
      disposalMethod: 'Rinse glass containers, remove caps/lids, and place in your recycling bin. Some areas require color separation.',
    };
  }

  // Metal detection
  if (labelTexts.some(l => ['metal', 'aluminum', 'can', 'tin', 'steel'].includes(l))) {
    return {
      type: 'Metal',
      category: 'recyclable',
      confidence: Math.round(maxConfidence * 100),
      recyclingInfo: 'Metal cans (aluminum and steel) are highly valuable recyclable materials.',
      disposalMethod: 'Rinse cans, crush to save space, and place in recycling bin. Metal foil and trays are also recyclable.',
    };
  }

  // Organic/Food waste detection
  if (labelTexts.some(l => ['food', 'fruit', 'vegetable', 'organic', 'plant', 'leaf'].includes(l))) {
    return {
      type: 'Organic Waste',
      category: 'biodegradable',
      confidence: Math.round(maxConfidence * 100),
      recyclingInfo: 'Organic waste can be composted to create nutrient-rich soil and reduce methane emissions from landfills.',
      disposalMethod: 'Compost at home or use green waste bins. Avoid meat, dairy, and oily foods in home composting.',
    };
  }

  // Electronic waste detection
  if (labelTexts.some(l => ['electronic', 'phone', 'computer', 'battery', 'gadget', 'device'].includes(l))) {
    return {
      type: 'Electronic Waste',
      category: 'hazardous',
      confidence: Math.round(maxConfidence * 100),
      recyclingInfo: 'E-waste contains valuable materials and hazardous substances. Never throw electronics in regular trash.',
      disposalMethod: 'Take to designated e-waste collection centers or retailer take-back programs. Delete personal data first.',
    };
  }

  // Battery detection
  if (labelTexts.some(l => ['battery', 'batteries', 'cell'].includes(l))) {
    return {
      type: 'Batteries',
      category: 'hazardous',
      confidence: Math.round(maxConfidence * 100),
      recyclingInfo: 'Batteries contain toxic materials and must be recycled properly to prevent environmental contamination.',
      disposalMethod: 'Take to battery collection points at retail stores or hazardous waste facilities. Never throw in regular trash.',
    };
  }

  // Textile detection
  if (labelTexts.some(l => ['textile', 'fabric', 'clothing', 'cloth', 'shirt', 'pants'].includes(l))) {
    return {
      type: 'Textiles',
      category: 'recyclable',
      confidence: Math.round(maxConfidence * 100),
      recyclingInfo: 'Textiles can be donated, recycled, or repurposed to reduce landfill waste.',
      disposalMethod: 'Donate wearable clothing to charity, use textile recycling bins for damaged items, or repurpose as cleaning rags.',
    };
  }

  // Default general waste
  return {
    type: 'General Waste',
    category: 'general',
    confidence: Math.round(maxConfidence * 100),
    recyclingInfo: 'This item appears to be general waste. Check if any parts can be separated and recycled.',
    disposalMethod: 'Place in general waste bin. Consider if any components can be separated for recycling.',
  };
}

/**
 * Get waste scanning statistics for a user
 */
exports.getUserWasteScanStats = onCall(async (request) => {
  try {
    if (!request.auth) {
      throw new Error('User must be authenticated');
    }

    const scansSnapshot = await admin
      .firestore()
      .collection('wasteScans')
      .where('userId', '==', request.auth.uid)
      .get();

    const scans = scansSnapshot.docs.map(doc => doc.data());

    const stats = {
      totalScans: scans.length,
      byCategory: {
        recyclable: scans.filter(s => s.category === 'recyclable').length,
        biodegradable: scans.filter(s => s.category === 'biodegradable').length,
        hazardous: scans.filter(s => s.category === 'hazardous').length,
        general: scans.filter(s => s.category === 'general').length,
      },
      recentScans: scans.slice(-5).reverse(),
    };

    return stats;
  } catch (error) {
    logger.error('Error fetching waste scan stats:', error);
    throw new Error('Failed to fetch statistics');
  }
});