# bitBloom Cloud Functions

This repository contains the deployed Node.js Firebase Cloud Functions used by the BitBloom app. These functions handle backend logic such as aggregating business metrics, running daily ROI and reward batches, and returning team-level details for users.

## Functions

- **aggregateBusinessEvery10Min** – Scheduled function that runs every ten minutes. It traverses each user’s direct and indirect referrals, sums the total deposits for those users, and writes aggregated business metrics (total deposits and direct deposits) into the `business_metrics/{uid}` document in Firestore. This enables up ‑to ‑date business performance reporting.

- **dailyBatch** – Scheduled daily job that runs at 06:55 Asia/Karachi. It handles multiple phases:
  1. Collect ROI (return on investment) or refunds from user plans and auto reinvest renewals.
  2. Credit ROI/refunds to user wallets and record transactions (`roiTransactions` collection).
  3. Write plan purchases to `planTransactions` (with FCM notifications to the app).
  4. Credit multi‑level team rewards to user wallets and record team transactions (`teamTransactions` collection).
  This batch job ensures daily profit distributions and keeps transaction logs up‭to date.

- **getTeamLevels** – On‑call HTTPS function that returns team‑level information for a user. Called with `{ userId }`, it returns a summary of six levels showing the number of users in each level along with their deposit, total buying profit, and invested amount. Called with `{ userId, level: 3 }`, it returns an array of users in a specific level (e.g. level 3). This function is read‑only and doesn’t write any data.

## Getting Started

To deploy or run these cloud functions locally:

1. **Clone the repository**:
   ```bash
   git clone https://github.com/shayann07/bitBloom-Cloud-Functions.git
   cd bitBloom-Cloud-Functions
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Set up Firebase** using the Firebase CLI. If you haven’t already, install the CLI and log in:
   ```bash
   npm install -g firebase-tools
   firebase login
   ```

4. **Configure your Firebase project** by specifying your project ID:
   ```bash
   firebase use --add
   ```

5. **Add environment variables** (e.g. API keys, secret keys) using `firebase functions:config:set` or the `.env` file (not included for security).

6. **Deploy the functions**:
   ```bash
   firebase deploy --only functions
   ```

## Technologies Used

- **Node.js** – JavaScript runtime.
- **Firebase Cloud Functions** – Serverless functions for backend logic.
- **Cloud Firestore / Firebase Admin** – Database and admin SDK for server‑side access.

## License

This project is licensed under the **MIT License**. Feel free to use and modify as needed.

<!-- gitpulse:contribution index="1" timestamp="2026-04-24" -->
<!-- gitpulse:contribution index="2" timestamp="2026-04-24" -->
<!-- gitpulse:contribution index="3" timestamp="2026-04-24" -->
<!-- gitpulse:contribution index="4" timestamp="2026-04-24" -->
<!-- gitpulse:contribution index="5" timestamp="2026-04-24" -->
<!-- gitpulse:contribution index="6" timestamp="2026-04-24" -->
<!-- gitpulse:contribution index="7" timestamp="2026-04-24" -->
<!-- gitpulse:contribution index="8" timestamp="2026-04-24" -->
<!-- gitpulse:contribution index="9" timestamp="2026-04-24" -->
<!-- gitpulse:contribution index="10" timestamp="2026-04-24" -->
<!-- gitpulse:contribution index="11" timestamp="2026-04-24" -->