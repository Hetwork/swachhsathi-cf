# SwachhSathi - Cloud Functions

Firebase Cloud Functions for the SwachhSathi waste management application. This project provides backend functionality for garbage reporting, image analysis, worker management, and automated notifications.

## Features

### 🖼️ Image Analysis
- **analyzeGarbageImage**: Analyzes garbage images using Google Vision API with Gemini AI fallback to classify waste types (dead animals, garbage collection, construction waste, plastic waste, etc.)
- **compareBeforeAfter**: Compares before and after images of cleaning tasks to verify completion
- **analyzeWasteImage**: Analyzes waste images for classification and educational purposes

### 👷 Worker Management
- **createWorker**: Creates new worker accounts with email notifications
- **autoAssignNearestWorker**: Automatically assigns the nearest available worker to new reports using geolocation
- **onWorkerCreated**: Triggers welcome email when a new worker is registered

### 📊 Report Management
- **onReportAssigned**: Sends email notifications when reports are assigned to workers
- **onReportResolved**: Sends email notifications when reports are marked as resolved

### 📈 Statistics
- **getUserWasteScanStats**: Retrieves waste scanning statistics for users

## Tech Stack

- **Runtime**: Node.js 24
- **Framework**: Firebase Functions v2
- **Services**:
  - Google Cloud Vision API
  - Firebase Admin SDK
  - Firebase Firestore
  - Nodemailer for email notifications
  - Gemini AI (fallback for image analysis)

## Prerequisites

- Node.js 24 or higher
- Firebase CLI installed globally
- Firebase project with Firestore enabled
- Google Cloud Vision API enabled
- Gmail account with app password for sending emails

## Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd swachhsathi-cf
```

2. Install dependencies:
```bash
cd functions
npm install
```

3. Configure Firebase secrets:
```bash
firebase functions:secrets:set GMAIL_EMAIL
firebase functions:secrets:set GMAIL_APP_PASSWORD
firebase functions:secrets:set GEMINI_API_KEY
```

4. Update Firebase configuration:
```bash
firebase use <your-project-id>
```

## Development

### Run locally with emulators:
```bash
npm run serve
```

### Test functions in interactive shell:
```bash
npm run shell
```

### View logs:
```bash
npm run logs
```

## Deployment

Deploy all functions to Firebase:
```bash
npm run deploy
```

Or use Firebase CLI directly:
```bash
firebase deploy --only functions
```

## Environment Variables / Secrets

The following secrets must be configured:

| Secret | Description |
|--------|-------------|
| `GMAIL_EMAIL` | Gmail address for sending notifications |
| `GMAIL_APP_PASSWORD` | Gmail app-specific password |
| `GEMINI_API_KEY` | Google Gemini AI API key for image analysis fallback |

## Functions Overview

### Callable Functions (onCall)

#### `analyzeGarbageImage`
- **Parameters**: `{ imageUri: string }`
- **Returns**: Classification result with detected garbage type
- **Secrets**: GEMINI_API_KEY

#### `createWorker`
- **Parameters**: Worker details (email, name, etc.)
- **Returns**: Worker ID and confirmation
- **Secrets**: GMAIL_EMAIL, GMAIL_APP_PASSWORD

#### `compareBeforeAfter`
- **Parameters**: `{ beforeImageUri: string, afterImageUri: string }`
- **Returns**: Comparison analysis and cleanliness score

#### `analyzeWasteImage`
- **Parameters**: `{ imageUri: string }`
- **Returns**: Waste classification and educational information

#### `getUserWasteScanStats`
- **Parameters**: `{ userId: string }`
- **Returns**: User's waste scanning statistics

### Firestore Triggers

#### `autoAssignNearestWorker`
- **Trigger**: Document created in `reports` collection
- **Action**: Finds and assigns nearest available worker

#### `onReportResolved`
- **Trigger**: Document updated in `reports` collection
- **Action**: Sends resolution email notification

#### `onWorkerCreated`
- **Trigger**: Document created in `users` collection
- **Action**: Sends welcome email to new workers

#### `onReportAssigned`
- **Trigger**: Document updated in `reports` collection
- **Action**: Sends assignment notification to worker

## Garbage Classification Categories

The image analysis function can detect and classify:
- Dead Animals
- Garbage Collection
- Clean Public Space
- Overflowing Dustbins
- Construction Waste
- Plastic Waste
- E-Waste
- Organic Waste
- Medical Waste
- Hazardous Waste

## Email Notifications

The system sends automated emails for:
- Worker account creation
- Report assignments
- Report resolution
- Welcome messages for new workers

## Error Handling

All functions include comprehensive error handling and logging using Firebase Logger. Check logs using:
```bash
firebase functions:log
```

## Performance

- Max instances: 10 (configurable in `index.js`)
- Region: Default (us-central1, can be changed via `setGlobalOptions`)

## License

[Add your license here]

## Contributing

[Add contribution guidelines here]

## Support

For issues and questions, please contact the development team.
