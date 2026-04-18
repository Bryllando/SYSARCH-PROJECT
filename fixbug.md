I have a web-based Sit-in Monitoring System. I need you to do a full code audit 
and fix the following issues:

---

## 1. FIX ANNOUNCEMENT TEXT DISPLAY
The announcement text is not displaying properly — it looks broken/unformatted.
- Fix text rendering so it displays cleanly and readable
- Ensure emojis, line breaks, and special characters render correctly
- Make sure the announcement card layout looks proper and professional
- Fix any CSS/HTML issues causing the text to look "wala tarong" (broken/misaligned)

---

## 2. FULL CODE AUDIT — BUG FIXES & LOGIC
Go through ALL files and:
- Fix any bugs (runtime errors, logic errors, broken routes)
- Fix how the Sit-in Monitoring works end-to-end:
  * Student sit-in registration / check-in flow
  * Check-out / session ending flow
  * Duration tracking (time in - time out)
  * Sit-in status updates (active, completed, timed out)
  * Database records being saved correctly
  * Admin monitoring view showing real-time or accurate data
- Fix any broken relationships between tables/models
- Fix any incorrect queries or missing validations

---

## 3. AI FEATURES AUDIT — Make It Work Properly
Check and fix all AI-powered features for both STUDENT and ADMIN:

### For Students:
- AI Recommendations — is it giving real, personalized suggestions?
- AI Tips — are they relevant and dynamic or just static text?
- AI Insights — does it analyze the student's own sit-in data/behavior?

### For Admin:
- AI Insights Dashboard — does it analyze overall lab usage patterns?
- AI Recommendations — is it giving actionable admin suggestions?
- AI Tips — are they based on real data from the system?

### Make sure:
- AI calls are actually hitting an AI API (not just hardcoded/fake responses)
- Prompts sent to the AI include real data from the database (student history, 
  usage stats, frequency, time patterns, etc.)
- AI responses are displayed properly in the UI
- If AI is broken or not connected, fix and connect it properly
- AI should feel REAL and USEFUL, not placeholder text

---

## Please:
1. Show me what files you are checking
2. List all bugs and issues found
3. Fix them one by one with clear explanations
4. Make sure everything works together as a complete system