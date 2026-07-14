# Chronasense Browser Extension — Setup

## One-time setup (developer)

Before the extension works, you need to add your OAuth Client ID to manifest.json.

### Step 1: Get your Extension ID
1. Open Edge/Chrome → `edge://extensions` or `chrome://extensions`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked" → select this `browser-extension` folder
4. Copy the **Extension ID** shown (looks like: `abcdefghijklmnopqrstuvwxyzabcdef`)

### Step 2: Create OAuth Client ID
1. Go to https://console.cloud.google.com
2. Select your project (time-audit-3c3da)
3. APIs & Services → Credentials → Create Credentials → OAuth Client ID
4. Application type: **Chrome Extension**
5. Extension ID: paste the ID from Step 1
6. Copy the generated Client ID

### Step 3: Update manifest.json
Replace `REPLACE_WITH_YOUR_OAUTH_CLIENT_ID` with your actual Client ID:
```json
"oauth2": {
  "client_id": "YOUR_CLIENT_ID_HERE.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/userinfo.email"]
}
```

### Step 4: Reload the extension
In extensions page, click the refresh icon on the Chronasense Tracker extension.

## Sharing with others (e.g. your wife on Mac)
1. Zip this folder and send it
2. Chrome → `chrome://extensions` → Developer mode ON → Load unpacked → select folder
3. They sign in with their own Google account
4. Their usage logs to their own Chronasense account automatically
