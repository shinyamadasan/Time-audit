export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDQeoZ1o1uz7adi1fLQiC6VKFCJ-6q8kgA",
  authDomain: "time-audit-3c3da.firebaseapp.com",
  databaseURL: "https://time-audit-3c3da-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "time-audit-3c3da"
};

// Sites to track — label + energy level
// energy: 'waste' = distraction, 'shallow' = shallow work, 'deep' = deep work
export const TRACKED_SITES = {
  "youtube.com":       { label: "YouTube",       energy: "waste"   },
  "instagram.com":     { label: "Instagram",     energy: "waste"   },
  "tiktok.com":        { label: "TikTok",        energy: "waste"   },
  "facebook.com":      { label: "Facebook",      energy: "waste"   },
  "twitter.com":       { label: "Twitter/X",     energy: "waste"   },
  "x.com":             { label: "Twitter/X",     energy: "waste"   },
  "reddit.com":        { label: "Reddit",        energy: "waste"   },
  "snapchat.com":      { label: "Snapchat",      energy: "waste"   },
  "pinterest.com":     { label: "Pinterest",     energy: "waste"   },
  "netflix.com":       { label: "Netflix",       energy: "waste"   },
  "twitch.tv":         { label: "Twitch",        energy: "waste"   },
  "linkedin.com":      { label: "LinkedIn",      energy: "shallow" },
  "gmail.com":         { label: "Gmail",         energy: "shallow" },
  "mail.google.com":   { label: "Gmail",         energy: "shallow" },
  "meet.google.com":   { label: "Google Meet",   energy: "shallow" },
  "zoom.us":           { label: "Zoom",          energy: "shallow" },
  "docs.google.com":   { label: "Google Docs",   energy: "shallow" },
  "sheets.google.com": { label: "Google Sheets", energy: "shallow" },
  "notion.so":         { label: "Notion",        energy: "shallow" },
  "slack.com":         { label: "Slack",         energy: "shallow" },
  "figma.com":         { label: "Figma",         energy: "deep"    },
  "github.com":        { label: "GitHub",        energy: "deep"    }
};

export const MIN_SESSION_MS = 60 * 1000; // ignore sessions under 1 minute
export const MERGE_WINDOW_MS = 10 * 60 * 1000; // merge same-site sessions within 10 min
