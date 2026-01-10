/**
 * Firebase Functions with Secrets for Nodemailer
 */

const { onCall } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2/options");
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
/**
 * analyzeGarbageImage Function (unchanged)
 */
exports.analyzeGarbageImage = onCall(async (request) => {
  try {
    const { imageUri } = request.data;

    const [labelResult] = await client.labelDetection(imageUri);
    const [objectResult] = await client.objectLocalization(imageUri);

    const labels = labelResult.labelAnnotations || [];
    const objects = objectResult.localizedObjectAnnotations || [];

    const garbageKeywords = {
      plastic: ["plastic", "bottle", "bag", "container", "packaging", "wrapper"],
      food: ["food", "organic", "waste", "leftover", "rotten"],
      electronic: ["electronic", "device", "battery", "wire", "circuit"],
      paper: ["paper", "cardboard", "newspaper", "document"],
      metal: ["metal", "can", "aluminum", "steel"],
      glass: ["glass", "bottle", "jar"],
      general: ["garbage", "trash", "waste", "litter", "rubbish", "debris"],
    };

    let isGarbageDetected = false;
    let category = "Mixed Waste";
    let maxScore = 0;
    let detectedItems = [];

    labels.forEach((label) => {
      const desc = label.description.toLowerCase();
      detectedItems.push(label.description);

      Object.keys(garbageKeywords).forEach((cat) => {
        if (garbageKeywords[cat].some((keyword) => desc.includes(keyword))) {
          isGarbageDetected = true;
          if (label.score > maxScore) {
            maxScore = label.score;
            category = cat.charAt(0).toUpperCase() + cat.slice(1) + " Waste";
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
    };
  } catch (error) {
    console.error("AI Analysis error:", error);
    throw new Error("Failed to analyze image: " + error.message);
  }
});

exports.createWorker = onCall(
  {
    secrets: [GMAIL_EMAIL, GMAIL_APP_PASSWORD],
  },
  async (request) => {
    try {
      const { email, password, name, phone } = request.data;

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
      throw new Error('Both before and after image URLs are required');
    }

    // Analyze both images
    const [beforeResult] = await client.labelDetection(beforeImageUrl);
    const [afterResult] = await client.labelDetection(afterImageUrl);

    const beforeLabels = beforeResult.labelAnnotations.map(label => label.description.toLowerCase());
    const afterLabels = afterResult.labelAnnotations.map(label => label.description.toLowerCase());

    // Garbage-related keywords
    const garbageKeywords = [
      'waste', 'garbage', 'trash', 'litter', 'rubbish', 'debris',
      'plastic', 'bottle', 'bag', 'wrapper', 'container', 'pollution'
    ];

    // Count garbage indicators in both images
    const beforeGarbageCount = beforeLabels.filter(label => 
      garbageKeywords.some(keyword => label.includes(keyword))
    ).length;

    const afterGarbageCount = afterLabels.filter(label => 
      garbageKeywords.some(keyword => label.includes(keyword))
    ).length;

    // Clean indicators
    const cleanKeywords = ['clean', 'tidy', 'neat', 'organized', 'clear', 'empty'];
    const afterCleanCount = afterLabels.filter(label => 
      cleanKeywords.some(keyword => label.includes(keyword))
    ).length;

    // Calculate cleanliness score (0-100)
    const garbageReduction = Math.max(0, beforeGarbageCount - afterGarbageCount);
    const cleanlinessScore = Math.min(100, Math.round(
      ((garbageReduction / Math.max(beforeGarbageCount, 1)) * 60) + 
      (afterCleanCount * 10) + 
      (afterGarbageCount === 0 ? 20 : 0)
    ));

    // Determine if area is clean enough
    const isClean = cleanlinessScore >= 70 || (afterGarbageCount === 0 && beforeGarbageCount > 0);

    let message;
    if (isClean) {
      message = 'Great job! The area has been successfully cleaned.';
    } else if (cleanlinessScore >= 50) {
      message = 'Good progress, but the area needs more cleaning.';
    } else {
      message = 'The area still appears to have significant garbage. Please clean more thoroughly.';
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
    console.error('Error comparing images:', error);
    throw new Error('Failed to compare images: ' + error.message);
  }
});